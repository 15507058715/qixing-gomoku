import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const app = express()
app.use(express.json({ limit: '2mb' }))
const httpServer = createServer(app)
const io = new Server(httpServer, { cors: { origin: true, credentials: false } })
const PORT = process.env.PORT || 10000
const SIZE = 15
const FIXED_ROOM_CODE = 'FEIYAN'
const rooms = new Map()
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions'
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'

const emptyBoard = () => Array.from({ length: SIZE }, () => Array(SIZE).fill(null))
const PRESENCE_ONLINE_MS = 6_000
const MAX_VOICE_BASE64_CHARS = 1_400_000
const MAX_VOICE_MESSAGES = 40
const activePlayers = (room) => [...room.players.values()].filter((player) => !player.left)
const playerPresence = (player) => {
  if (player.left) return 'left'
  if (player.away) return 'away'
  if (player.lastSeen && Date.now() - player.lastSeen > PRESENCE_ONLINE_MS) return 'disconnected'
  return 'online'
}
const publicRoom = (room) => ({
  code: room.code,
  players: [...room.players.values()].map(({ id, name, color, ...player }) => ({ id, name, color, presence: playerPresence(player), isAi: player.aiEnabled === true })),
  board: room.board,
  turn: room.turn,
  moves: room.moves,
  winner: room.winner,
  chat: room.chat,
  lastMoveAt: room.lastMoveAt,
  undo: room.undo,
  drawOffer: room.drawOffer,
  swapOffer: room.swapOffer,
  rematchOffer: room.rematchOffer,
})
const clearRoomChat = (room) => {
  room.chat = []
  room.voiceMessages?.clear()
}
const trimRoomChat = (room) => {
  room.chat = room.chat.slice(-100)
  const voiceIds = new Set(room.chat.filter((message) => message.kind === 'voice').map((message) => message.id))
  for (const id of room.voiceMessages?.keys() || []) if (!voiceIds.has(id)) room.voiceMessages.delete(id)
  while ((room.voiceMessages?.size || 0) > MAX_VOICE_MESSAGES) {
    const oldest = room.voiceMessages.keys().next().value
    room.voiceMessages.delete(oldest)
    room.chat = room.chat.filter((message) => message.id !== oldest)
  }
}
const emitRoom = (room) => io.to(room.code).emit('room-state', publicRoom(room))
const makeCode = () => {
  let code
  do {
    code = crypto.randomBytes(3).toString('hex').toUpperCase()
  } while (rooms.has(code) || code === FIXED_ROOM_CODE)
  return code
}
const inBounds = (x, y) => x >= 0 && x < SIZE && y >= 0 && y < SIZE
const hasFive = (board, x, y, color) => {
  const directions = [[1, 0], [0, 1], [1, 1], [1, -1]]
  return directions.some(([dx, dy]) => {
    let count = 1
    for (const sign of [1, -1]) {
      let nx = x + dx * sign
      let ny = y + dy * sign
      while (inBounds(nx, ny) && board[ny][nx] === color) {
        count += 1
        nx += dx * sign
        ny += dy * sign
      }
    }
    return count >= 5
  })
}

const isBoard = (board) => Array.isArray(board) && board.length === SIZE && board.every((row) => Array.isArray(row) && row.length === SIZE && row.every((cell) => cell === null || cell === 'black' || cell === 'white'))
const moveFromDeepSeekContent = (content, board) => {
  const raw = Array.isArray(content) ? content.map((part) => part?.text || '').join('') : String(content || '')
  const candidate = raw.replace(/```json|```/gi, '').match(/\{[\s\S]*\}/)?.[0]
  if (!candidate) return null
  let parsed
  try { parsed = JSON.parse(candidate) } catch { return null }
  const x = Number(parsed.x)
  const y = Number(parsed.y)
  if (!Number.isInteger(x) || !Number.isInteger(y) || !inBounds(x, y) || board[y][x] !== null) return null
  return { x, y }
}
const requestDeepSeekMove = async ({ board, moves, aiColor }) => {
  if (!process.env.DEEPSEEK_API_KEY) {
    const error = new Error('DeepSeek 尚未配置')
    error.status = 503
    throw error
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        temperature: 0.1,
        max_tokens: 80,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你是五子棋落子引擎。只返回一个JSON对象，不要解释，格式严格为 {"x":整数,"y":整数}。棋盘坐标从0到14，必须选择空位。优先完成己方五连，其次阻止对方五连。' },
          { role: 'user', content: JSON.stringify({ size: SIZE, aiColor, board, moves }) },
        ],
      }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error('DeepSeek 请求失败')
      error.status = response.status >= 500 ? 502 : 400
      throw error
    }
    const move = moveFromDeepSeekContent(body?.choices?.[0]?.message?.content, board)
    if (!move) {
      const error = new Error('DeepSeek 返回了无效落子')
      error.status = 502
      throw error
    }
    return { ...move, model: body.model || DEEPSEEK_MODEL }
  } finally {
    clearTimeout(timeout)
  }
}

const createHttpPlayer = (name, color, deviceId = '') => ({
  id: crypto.randomUUID(),
  token: crypto.randomBytes(24).toString('hex'),
  deviceId,
  name: String(name || '棋手').slice(0, 16),
  color,
  lastSeen: Date.now(),
  away: false,
  left: false,
})
const findHttpPlayer = (room, token, includeLeft = false) => [...room.players.values()].find((player) => player.token === token && (includeLeft || !player.left))
const createHttpRoom = (code) => ({
  code, host: null, transport: 'http', players: new Map(), board: emptyBoard(), turn: 'black', moves: [], winner: null,
  chat: [], voiceMessages: new Map(), lastMoveAt: null, undo: null, drawOffer: null, swapOffer: null, rematchOffer: null, signals: [], signalSeq: 0, updatedAt: Date.now(), aiThinking: false,
})
const ensureFixedRoom = () => {
  const existing = rooms.get(FIXED_ROOM_CODE)
  if (existing?.transport === 'http') return existing
  const room = createHttpRoom(FIXED_ROOM_CODE)
  rooms.set(FIXED_ROOM_CODE, room)
  return room
}
const connectFixedPlayer = (room, deviceId, name) => {
  let player = [...room.players.values()].find((candidate) => candidate.deviceId === deviceId)
  if (player) {
    if (player.left && activePlayers(room).length >= 2) return null
    player.name = String(name || player.name || '棋手').slice(0, 16)
    player.left = false
    player.away = false
    player.lastSeen = Date.now()
    return player
  }
  const stale = activePlayers(room).find((candidate) => playerPresence(candidate) === 'disconnected')
  if (stale) stale.left = true
  const active = activePlayers(room)
  if (active.length >= 2) return null
  const color = active.some((candidate) => candidate.color === 'black') ? 'white' : 'black'
  player = createHttpPlayer(name, color, deviceId)
  room.players.set(player.id, player)
  room.host ||= player.id
  return player
}
const apiRoomState = (room, player, afterSignal = 0) => ({
  ok: true,
  state: publicRoom(room),
  signals: room.signals.filter((signal) => signal.to === player.id && signal.seq > afterSignal).slice(-200),
})
const handleHttpAction = async (room, player, type, payload) => {
  if (type === 'leave') {
    player.left = true
    player.away = false
    player.lastSeen = Date.now()
    room.undo = null
    room.drawOffer = null
    room.swapOffer = null
    room.rematchOffer = null
    return { ok: true }
  }
  if (type === 'presence') {
    player.away = payload.away === true
    return { ok: true }
  }
  if (type === 'ai-toggle') {
    const enabled = payload.enabled === true
    player.aiEnabled = enabled
    return { ok: true }
  }
  if (type === 'ai-move') {
    if (!player.aiEnabled) return { ok: false, error: 'DeepSeek AI 未开启' }
    if (room.aiThinking) return { ok: false, error: 'DeepSeek 正在思考' }
    if (room.winner) return { ok: false, error: '对局已结束' }
    if (room.undo || room.drawOffer || room.swapOffer) return { ok: false, error: '请先回应当前请求' }
    if (room.turn !== player.color) return { ok: false, error: '还没轮到你' }
    room.aiThinking = true
    try {
      const move = await requestDeepSeekMove({ board: room.board, moves: room.moves, aiColor: player.color })
      if (!player.aiEnabled) return { ok: false, error: 'DeepSeek AI 已停止' }
      room.board[move.y][move.x] = player.color
      room.moves.push({ x: move.x, y: move.y, color: player.color, playerId: player.id, at: Date.now() })
      room.lastMoveAt = Date.now()
      if (hasFive(room.board, move.x, move.y, player.color)) room.winner = player.color
      else if (room.moves.length === SIZE * SIZE) room.winner = 'draw'
      else room.turn = player.color === 'black' ? 'white' : 'black'
      return { ok: true, ...move }
    } finally {
      room.aiThinking = false
    }
  }
  if (type === 'move') {
    const { x, y } = payload
    if (activePlayers(room).length < 2 && !player.aiEnabled) return { ok: false, error: '对手不在房间' }
    if (room.winner) return { ok: false, error: '对局已结束' }
    if (room.undo || room.drawOffer || room.swapOffer) return { ok: false, error: '请先回应当前请求' }
    if (room.turn !== player.color) return { ok: false, error: '还没轮到你' }
    if (!inBounds(x, y) || room.board[y][x]) return { ok: false, error: '这个位置不能落子' }
    room.board[y][x] = player.color
    room.moves.push({ x, y, color: player.color, playerId: player.id, at: Date.now() })
    room.lastMoveAt = Date.now()
    if (hasFive(room.board, x, y, player.color)) room.winner = player.color
    else if (room.moves.length === SIZE * SIZE) room.winner = 'draw'
    else room.turn = player.color === 'black' ? 'white' : 'black'
    return { ok: true }
  }
  if (type === 'undo-request') {
    const last = room.moves.at(-1)
    if (!last || last.playerId !== player.id || room.winner) return { ok: false, error: '只能撤回自己刚落下的棋子' }
    if (room.undo || room.drawOffer || room.swapOffer) return { ok: false, error: '已有请求等待回应' }
    room.undo = { from: player.id }
    return { ok: true }
  }
  if (type === 'undo-response') {
    if (!room.undo || room.undo.from === player.id) return { ok: false, error: '没有需要回应的悔棋请求' }
    if (payload.accept) {
      const last = room.moves.pop()
      if (last) {
        room.board[last.y][last.x] = null
        room.turn = last.color
      }
      room.winner = null
      room.lastMoveAt = room.moves.at(-1)?.at || null
    }
    room.undo = null
    return { ok: true }
  }
  if (type === 'draw-request') {
    if (activePlayers(room).length < 2 || room.winner) return { ok: false, error: '现在不能求和' }
    if (room.undo || room.drawOffer || room.swapOffer) return { ok: false, error: '已有请求等待回应' }
    room.drawOffer = { from: player.id }
    return { ok: true }
  }
  if (type === 'draw-response') {
    if (!room.drawOffer || room.drawOffer.from === player.id) return { ok: false, error: '没有需要回应的求和请求' }
    if (payload.accept) room.winner = 'draw'
    room.drawOffer = null
    room.undo = null
    return { ok: true }
  }
  if (type === 'swap-request') {
    if (room.winner) return { ok: false, error: '对局结束后不能换边' }
    if (room.undo || room.drawOffer || room.swapOffer) return { ok: false, error: '已有请求等待回应' }
    if (activePlayers(room).length < 2) {
      player.color = player.color === 'black' ? 'white' : 'black'
      return { ok: true }
    }
    room.swapOffer = { from: player.id }
    return { ok: true }
  }
  if (type === 'swap-response') {
    if (!room.swapOffer || room.swapOffer.from === player.id) return { ok: false, error: '没有需要回应的换边请求' }
    if (payload.accept) for (const participant of room.players.values()) participant.color = participant.color === 'black' ? 'white' : 'black'
    room.swapOffer = null
    return { ok: true }
  }
  if (type === 'rematch-request') {
    if ((!player.aiEnabled && activePlayers(room).length < 2) || !room.winner) return { ok: false, error: '对局结束后才能再来一局' }
    if (room.rematchOffer) return { ok: false, error: '已发出再来一局请求' }
    if (player.aiEnabled && activePlayers(room).length < 2) {
      room.board = emptyBoard()
      room.turn = 'black'
      room.moves = []
      room.winner = null
      clearRoomChat(room)
      room.lastMoveAt = null
      room.undo = null
      room.drawOffer = null
      room.swapOffer = null
      room.signals = []
      return { ok: true }
    }
    room.rematchOffer = { from: player.id }
    return { ok: true }
  }
  if (type === 'rematch-response') {
    if (!room.rematchOffer || room.rematchOffer.from === player.id) return { ok: false, error: '没有需要回应的再来一局请求' }
    if (payload.accept) {
      for (const participant of room.players.values()) participant.color = participant.color === 'black' ? 'white' : 'black'
      room.board = emptyBoard()
      room.turn = 'black'
      room.moves = []
      room.winner = null
      clearRoomChat(room)
      room.lastMoveAt = null
      room.undo = null
      room.drawOffer = null
      room.swapOffer = null
      room.signals = []
    }
    room.rematchOffer = null
    return { ok: true }
  }
  if (type === 'chat') {
    const clean = String(payload.text || '').trim().slice(0, 240)
    if (!clean) return { ok: false, error: '消息不能为空' }
    room.chat.push({ id: crypto.randomUUID(), playerId: player.id, name: player.name, color: player.color, kind: 'text', text: clean, at: Date.now() })
    trimRoomChat(room)
    return { ok: true }
  }
  if (type === 'voice-message') {
    const peer = activePlayers(room).find((candidate) => candidate.id !== player.id)
    const audio = String(payload.audio || '')
    const durationMs = Math.max(500, Math.min(60_000, Number(payload.durationMs) || 0))
    if (!peer) return { ok: false, error: '对手不在房间' }
    if (!audio || audio.length > MAX_VOICE_BASE64_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) return { ok: false, error: '语音消息无效' }
    const data = Buffer.from(audio, 'base64')
    if (!data.length || data.length > 1_000_000) return { ok: false, error: '语音消息太大' }
    const id = crypto.randomUUID()
    room.voiceMessages.set(id, { data, mime: 'audio/mp4' })
    room.chat.push({ id, playerId: player.id, name: player.name, color: player.color, kind: 'voice', text: '', durationMs, at: Date.now() })
    trimRoomChat(room)
    return { ok: true, messageId: id }
  }
  if (['voice-offer', 'voice-answer', 'voice-ice', 'voice-state', 'voice-audio'].includes(type)) {
    const peer = activePlayers(room).find((candidate) => candidate.id !== player.id)
    if (!peer) return { ok: false, error: '对手还没有加入' }
    if (type === 'voice-audio') {
      const audio = String(payload.audio || '')
      if (!audio || audio.length > 18_000) return { ok: false, error: '语音分片无效' }
      payload = { audio }
    }
    room.signalSeq += 1
    room.signals.push({ id: crypto.randomUUID(), seq: room.signalSeq, from: player.id, to: peer.id, type, payload, at: Date.now() })
    room.signals = room.signals.slice(-160)
    return { ok: true }
  }
  return { ok: false, error: '未知操作' }
}

app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size, protocol: 'voice-messages-v1' }))
app.get('/', (_req, res) => res.json({ service: 'qixing-gomoku', client: 'android', protocol: 'voice-messages-v1' }))

app.post('/api/ai/move', async (req, res) => {
  const board = req.body?.board
  const moves = req.body?.moves
  const aiColor = req.body?.aiColor
  if (!isBoard(board) || !Array.isArray(moves) || moves.length > SIZE * SIZE || !['black', 'white'].includes(aiColor)) {
    return res.status(400).json({ ok: false, error: '棋局数据无效' })
  }
  try {
    const move = await requestDeepSeekMove({ board, moves, aiColor })
    return res.json({ ok: true, ...move })
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 502
    return res.status(status).json({ ok: false, error: error?.message || 'AI 暂时不可用' })
  }
})

app.get('/api/fixed-room/presence', (req, res) => {
  const deviceId = String(req.query.deviceId || '').trim().slice(0, 80)
  if (!deviceId) return res.json({ ok: false, error: '设备标识无效' })
  const room = ensureFixedRoom()
  const player = connectFixedPlayer(room, deviceId, req.query.name)
  if (!player) return res.json({ ok: false, error: '专属房间已满' })
  room.updatedAt = Date.now()
  const opponent = activePlayers(room).find((candidate) => candidate.id !== player.id)
  res.json({
    ok: true,
    code: room.code,
    opponentPresence: opponent ? playerPresence(opponent) : 'disconnected',
  })
})

app.post('/api/fixed-room/connect', (req, res) => {
  const deviceId = String(req.body?.deviceId || '').trim().slice(0, 80)
  if (!deviceId) return res.json({ ok: false, error: '设备标识无效' })
  const room = ensureFixedRoom()
  const player = connectFixedPlayer(room, deviceId, req.body?.name)
  if (!player) return res.json({ ok: false, error: '专属房间已满' })
  room.updatedAt = Date.now()
  res.json({ ok: true, code: room.code, playerId: player.id, token: player.token, color: player.color, state: publicRoom(room) })
})

app.post('/api/rooms', (req, res) => {
  const code = makeCode()
  const player = createHttpPlayer(req.body?.name, 'black')
  const room = createHttpRoom(code)
  room.host = player.id
  room.players.set(player.id, player)
  rooms.set(code, room)
  res.json({ ok: true, code, playerId: player.id, token: player.token, color: player.color, state: publicRoom(room) })
})

app.post('/api/rooms/:code/join', (req, res) => {
  const room = rooms.get(String(req.params.code || '').toUpperCase())
  if (!room || room.transport !== 'http') return res.json({ ok: false, error: '房间不存在或已结束' })
  if (room.players.size >= 2) return res.json({ ok: false, error: '房间已满' })
  const color = [...room.players.values()].some((player) => player.color === 'black') ? 'white' : 'black'
  const player = createHttpPlayer(req.body?.name, color)
  room.players.set(player.id, player)
  room.updatedAt = Date.now()
  res.json({ ok: true, code: room.code, playerId: player.id, token: player.token, color, state: publicRoom(room) })
})

app.get('/api/rooms/:code/state', (req, res) => {
  const room = rooms.get(String(req.params.code || '').toUpperCase())
  const player = room && room.transport === 'http' ? findHttpPlayer(room, String(req.query.token || '')) : null
  if (!room || !player) return res.json({ ok: false, error: '房间不存在或已结束' })
  player.lastSeen = Date.now()
  room.updatedAt = Date.now()
  const afterSignal = Math.max(0, Number.parseInt(String(req.query.afterSignal || '0'), 10) || 0)
  res.json(apiRoomState(room, player, afterSignal))
})

app.get('/api/rooms/:code/voice/:messageId', (req, res) => {
  const room = rooms.get(String(req.params.code || '').toUpperCase())
  const player = room && room.transport === 'http' ? findHttpPlayer(room, String(req.query.token || '')) : null
  const voice = room?.voiceMessages?.get(String(req.params.messageId || ''))
  if (!room || !player || !voice) return res.status(404).end()
  player.lastSeen = Date.now()
  res.set('Content-Type', voice.mime)
  res.set('Cache-Control', 'no-store')
  res.send(voice.data)
})

app.post('/api/rooms/:code/action', async (req, res) => {
  const room = rooms.get(String(req.params.code || '').toUpperCase())
  const requestedType = String(req.body?.type || '')
  const player = room && room.transport === 'http' ? findHttpPlayer(room, String(req.body?.token || ''), requestedType === 'leave') : null
  if (!room || !player) return res.json({ ok: false, error: '房间不存在或已结束' })
  player.lastSeen = Date.now()
  room.updatedAt = Date.now()
  try {
    const result = await handleHttpAction(room, player, requestedType, req.body?.payload || {})
    if (!activePlayers(room).length) rooms.delete(room.code)
    res.json(result)
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 502
    res.status(status).json({ ok: false, error: error?.message || 'AI 暂时不可用' })
  }
})

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  for (const [code, room] of rooms) if (room.transport === 'http' && room.updatedAt < cutoff) rooms.delete(code)
}, 10 * 60 * 1000).unref()

io.on('connection', (socket) => {
  socket.on('create-room', ({ name }, ack) => {
    const code = makeCode()
    const room = { code, host: socket.id, players: new Map(), board: emptyBoard(), turn: 'black', moves: [], winner: null, chat: [], lastMoveAt: null, undo: null, drawOffer: null, swapOffer: null, rematchOffer: null }
    room.players.set(socket.id, { id: socket.id, name: String(name || '棋手').slice(0, 16), color: 'black' })
    rooms.set(code, room)
    socket.join(code)
    socket.data.room = code
    ack?.({ ok: true, code, color: 'black', state: publicRoom(room) })
    emitRoom(room)
  })

  socket.on('join-room', ({ code, name }, ack) => {
    const room = rooms.get(String(code || '').trim().toUpperCase())
    if (!room) return ack?.({ ok: false, error: '房间不存在或已结束' })
    if (room.players.size >= 2) return ack?.({ ok: false, error: '房间已满' })
    const color = room.players.has(room.host) ? 'white' : 'black'
    room.players.set(socket.id, { id: socket.id, name: String(name || '棋手').slice(0, 16), color })
    socket.join(room.code)
    socket.data.room = room.code
    ack?.({ ok: true, code: room.code, color, state: publicRoom(room) })
    emitRoom(room)
  })

  socket.on('move', ({ x, y }, ack) => {
    const room = rooms.get(socket.data.room)
    const player = room?.players.get(socket.id)
    if (!room || !player) return ack?.({ ok: false, error: '不在对局中' })
    if (room.players.size < 2) return ack?.({ ok: false, error: '等待对手加入' })
    if (room.winner) return ack?.({ ok: false, error: '对局已结束' })
    if (room.undo || room.drawOffer || room.swapOffer) return ack?.({ ok: false, error: '请先回应当前请求' })
    if (room.turn !== player.color) return ack?.({ ok: false, error: '还没轮到你' })
    if (!inBounds(x, y) || room.board[y][x]) return ack?.({ ok: false, error: '这个位置不能落子' })
    room.board[y][x] = player.color
    room.moves.push({ x, y, color: player.color, playerId: socket.id, at: Date.now() })
    room.lastMoveAt = Date.now()
    room.undo = null
    if (hasFive(room.board, x, y, player.color)) room.winner = player.color
    else if (room.moves.length === SIZE * SIZE) room.winner = 'draw'
    else room.turn = player.color === 'black' ? 'white' : 'black'
    ack?.({ ok: true })
    emitRoom(room)
  })

  socket.on('undo-request', (_payload, ack) => {
    const room = rooms.get(socket.data.room)
    const player = room?.players.get(socket.id)
    const last = room?.moves.at(-1)
    if (!room || !player || !last || last.playerId !== socket.id || room.winner) return ack?.({ ok: false, error: '只能撤回自己刚落下的棋子' })
    if (room.undo || room.drawOffer || room.swapOffer) return ack?.({ ok: false, error: '已有请求等待回应' })
    room.undo = { from: socket.id }
    ack?.({ ok: true })
    emitRoom(room)
  })

  socket.on('undo-response', ({ accept }, ack) => {
    const room = rooms.get(socket.data.room)
    const player = room?.players.get(socket.id)
    if (!room || !player || !room.undo || room.undo.from === socket.id) return ack?.({ ok: false })
    if (accept) {
      const last = room.moves.pop()
      if (last) room.board[last.y][last.x] = null
      room.turn = last.color
      room.winner = null
      room.lastMoveAt = room.moves.at(-1)?.at || null
    }
    room.undo = null
    ack?.({ ok: true })
    emitRoom(room)
  })

  socket.on('draw-request', (_payload, ack) => {
    const room = rooms.get(socket.data.room)
    const player = room?.players.get(socket.id)
    if (!room || !player || room.players.size < 2 || room.winner) return ack?.({ ok: false, error: '现在不能求和' })
    if (room.undo || room.drawOffer || room.swapOffer) return ack?.({ ok: false, error: '已有请求等待回应' })
    room.drawOffer = { from: socket.id }
    ack?.({ ok: true })
    emitRoom(room)
  })

  socket.on('draw-response', ({ accept }, ack) => {
    const room = rooms.get(socket.data.room)
    const player = room?.players.get(socket.id)
    if (!room || !player || !room.drawOffer || room.drawOffer.from === socket.id) return ack?.({ ok: false })
    if (accept) room.winner = 'draw'
    room.drawOffer = null
    room.undo = null
    ack?.({ ok: true })
    emitRoom(room)
  })

  socket.on('swap-request', (_payload, ack) => {
    const room = rooms.get(socket.data.room)
    const player = room?.players.get(socket.id)
    if (!room || !player || room.winner) return ack?.({ ok: false, error: '对局结束后不能换边' })
    if (room.undo || room.drawOffer || room.swapOffer) return ack?.({ ok: false, error: '已有请求等待回应' })
    if (room.players.size < 2) player.color = player.color === 'black' ? 'white' : 'black'
    else room.swapOffer = { from: socket.id }
    ack?.({ ok: true })
    emitRoom(room)
  })

  socket.on('swap-response', ({ accept }, ack) => {
    const room = rooms.get(socket.data.room)
    const player = room?.players.get(socket.id)
    if (!room || !player || !room.swapOffer || room.swapOffer.from === socket.id) return ack?.({ ok: false })
    if (accept) for (const participant of room.players.values()) participant.color = participant.color === 'black' ? 'white' : 'black'
    room.swapOffer = null
    ack?.({ ok: true })
    emitRoom(room)
  })

  socket.on('rematch-request', (_payload, ack) => {
    const room = rooms.get(socket.data.room)
    const player = room?.players.get(socket.id)
    if (!room || !player || room.players.size < 2 || !room.winner) return ack?.({ ok: false, error: '对局结束后才能再来一局' })
    if (room.rematchOffer) return ack?.({ ok: false, error: '已发出再来一局请求' })
    room.rematchOffer = { from: socket.id }
    ack?.({ ok: true })
    emitRoom(room)
  })

  socket.on('rematch-response', ({ accept }, ack) => {
    const room = rooms.get(socket.data.room)
    const player = room?.players.get(socket.id)
    if (!room || !player || !room.rematchOffer || room.rematchOffer.from === socket.id) return ack?.({ ok: false })
    if (accept) {
      for (const participant of room.players.values()) participant.color = participant.color === 'black' ? 'white' : 'black'
      room.board = emptyBoard()
      room.turn = 'black'
      room.moves = []
      room.winner = null
      room.chat = []
      room.lastMoveAt = null
      room.undo = null
      room.drawOffer = null
    }
    room.rematchOffer = null
    ack?.({ ok: true })
    emitRoom(room)
  })

  socket.on('chat', ({ text }, ack) => {
    const room = rooms.get(socket.data.room)
    const player = room?.players.get(socket.id)
    const clean = String(text || '').trim().slice(0, 240)
    if (!room || !player || !clean) return ack?.({ ok: false })
    room.chat.push({ id: crypto.randomUUID(), name: player.name, color: player.color, text: clean, at: Date.now() })
    room.chat = room.chat.slice(-100)
    ack?.({ ok: true })
    emitRoom(room)
  })

  for (const event of ['voice-offer', 'voice-answer', 'voice-ice', 'voice-state']) {
    socket.on(event, (payload) => {
      const room = rooms.get(socket.data.room)
      if (room) socket.to(room.code).emit(event, { ...payload, from: socket.id })
    })
  }

  socket.on('disconnect', () => {
    const code = socket.data.room
    const room = rooms.get(code)
    if (!room) return
    room.players.delete(socket.id)
    socket.leave(code)
    if (!room.players.size) rooms.delete(code)
    else { room.undo = null; room.drawOffer = null; room.swapOffer = null; room.rematchOffer = null; emitRoom(room) }
  })
})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  httpServer.listen(PORT, '0.0.0.0', () => console.log(`qixing gomoku listening on ${PORT}`))
}

export { hasFive, emptyBoard, SIZE, isBoard, moveFromDeepSeekContent }
