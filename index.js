import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT || 3001)
const HOST = process.env.HOST || '0.0.0.0'
const DEFAULT_ACCESS_CODE = process.env.ACCESS_CODE || '1234'
const DEFAULT_ADMIN_PIN = process.env.ADMIN_PIN || '9999'
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'

const COLORS = ['MORADO', 'AMARILLO', 'CELESTE', 'ROJO', 'VERDE', 'NARANJA']

const rooms = new Map()

function createRoom(id) {
  return {
    id: id.toUpperCase(),
    accessCode: DEFAULT_ACCESS_CODE,
    adminPin: DEFAULT_ADMIN_PIN,
    round: 1,
    status: 'open',
    winningColor: null,
    streamActive: false,
    micMuted: true,
    cameraActive: false,
    screenActive: false,
    participants: new Map(),
    invites: new Map(),
    orders: [],
    chat: [],
    activity: ['Sala lista. Esperando jugadores.'],
  }
}

function inviteList(room) {
  return [...room.invites.values()].map(({ name, pin, id }) => ({ id, name, pin }))
}

function randomPin() {
  return String(Math.floor(1000 + Math.random() * 9000))
}

function getRoom(id) {
  const key = String(id || 'DANCE-204').toUpperCase()
  if (!rooms.has(key)) rooms.set(key, createRoom(key))
  return rooms.get(key)
}

function publicState(room) {
  const byColor = Object.fromEntries(COLORS.map((c) => [c, []]))
  const totals = Object.fromEntries(COLORS.map((c) => [c, 0]))

  for (const order of room.orders) {
    if (order.round !== room.round) continue
    byColor[order.color].push({
      id: order.id,
      name: order.name,
      quantity: order.quantity,
      participantId: order.participantId,
    })
    totals[order.color] += order.quantity
  }

  return {
    id: room.id,
    round: room.round,
    status: room.status,
    winningColor: room.winningColor,
    streamActive: room.streamActive,
    micMuted: room.micMuted,
    cameraActive: Boolean(room.cameraActive),
    screenActive: Boolean(room.screenActive),
    colors: COLORS,
    participants: [...room.participants.values()].map(({ id, name, role }) => ({ id, name, role })),
    ordersByColor: byColor,
    totals,
    chat: room.chat.slice(-80),
    activity: room.activity.slice(-12),
    viewerCount: [...room.participants.values()].filter((p) => p.role === 'viewer').length,
    invites: inviteList(room),
  }
}

function broadcast(room, payload, except) {
  const data = JSON.stringify(payload)
  for (const participant of room.participants.values()) {
    if (participant.ws === except) continue
    if (participant.ws.readyState === 1) participant.ws.send(data)
  }
}

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload))
}

function pushActivity(room, text) {
  room.activity.push(text)
  if (room.activity.length > 30) room.activity = room.activity.slice(-30)
}

function avatarColor(name) {
  const palette = ['red-bg', 'blue-bg', 'yellow-bg', 'green-bg', 'purple-bg']
  let hash = 0
  for (const ch of name) hash = (hash + ch.charCodeAt(0)) % palette.length
  return palette[hash]
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

const server = createServer((req, res) => {
  setCors(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (url.pathname === '/health' || url.pathname === '/api/health' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      service: 'ludito-backend',
      rooms: rooms.size,
      time: new Date().toISOString(),
    }))
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: 'Not found' }))
})

const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  let room = null
  let participant = null

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return send(ws, { type: 'error', message: 'Mensaje inválido' })
    }

    if (msg.type === 'join') {
      room = getRoom(msg.room)
      const name = String(msg.name || '').trim().slice(0, 24)
      const role = msg.role === 'admin' ? 'admin' : 'viewer'
      const code = String(msg.code || '').trim()

      let displayName = name

      if (role === 'admin') {
        if (!name) return send(ws, { type: 'error', message: 'Escribe tu nombre' })
        if (code !== room.adminPin) {
          return send(ws, { type: 'error', message: 'PIN de administrador incorrecto' })
        }
      } else {
        const invite = room.invites.get(code)
        if (invite) {
          displayName = invite.name
        } else if (code === room.accessCode) {
          displayName = name && name !== 'jugador' ? name : 'Invitado'
        } else {
          return send(ws, {
            type: 'error',
            message: 'PIN incorrecto. Abre tu link personal o escribe el PIN que te dio el admin.',
          })
        }
      }

      const id = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      participant = {
        id,
        name: displayName,
        role,
        avatar: displayName.slice(0, 1).toUpperCase(),
        color: avatarColor(displayName),
        ws,
      }
      room.participants.set(id, participant)
      pushActivity(room, `${displayName} entró a la sala`)
      send(ws, {
        type: 'joined',
        you: { id, name: displayName, role, avatar: participant.avatar, color: participant.color },
        state: publicState(room),
      })
      broadcast(room, { type: 'state', state: publicState(room) }, ws)
      return
    }

    if (!room || !participant) {
      return send(ws, { type: 'error', message: 'Primero únete a la sala' })
    }

    if (msg.type === 'create_invite') {
      if (participant.role !== 'admin') {
        return send(ws, { type: 'error', message: 'Solo el admin puede crear usuarios' })
      }
      const inviteName = String(msg.name || '').trim().slice(0, 24)
      if (!inviteName) return send(ws, { type: 'error', message: 'Escribe el nombre del usuario' })
      let pin = String(msg.pin || '').trim()
      if (!pin) pin = randomPin()
      if (!/^\d{4,6}$/.test(pin)) {
        return send(ws, { type: 'error', message: 'El PIN debe ser de 4 a 6 dígitos' })
      }
      if (pin === room.adminPin) {
        return send(ws, { type: 'error', message: 'Ese PIN está reservado para el admin' })
      }
      if (room.invites.has(pin) || pin === room.accessCode) {
        return send(ws, { type: 'error', message: 'Ese PIN ya existe, elige otro' })
      }
      const invite = { id: `inv-${Date.now()}`, name: inviteName, pin }
      room.invites.set(pin, invite)
      pushActivity(room, `Admin creó acceso para ${inviteName}`)
      broadcast(room, { type: 'state', state: publicState(room) })
      send(ws, { type: 'invite_created', invite })
      return
    }

    if (msg.type === 'delete_invite') {
      if (participant.role !== 'admin') return
      const pin = String(msg.pin || '').trim()
      const invite = room.invites.get(pin)
      if (!invite) return
      room.invites.delete(pin)
      pushActivity(room, `Se eliminó el acceso de ${invite.name}`)
      broadcast(room, { type: 'state', state: publicState(room) })
      return
    }

    if (msg.type === 'chat') {
      const text = String(msg.text || '').trim().slice(0, 180)
      if (!text) return
      const message = {
        id: Date.now(),
        user: participant.name,
        avatar: participant.avatar,
        color: participant.color,
        text,
        time: 'Ahora',
      }
      room.chat.push(message)
      broadcast(room, { type: 'chat', message })
      return
    }

    if (msg.type === 'order') {
      if (participant.role !== 'viewer' && participant.role !== 'admin') return
      if (room.status !== 'open') {
        return send(ws, { type: 'error', message: 'Las compras están cerradas' })
      }
      const color = String(msg.color || '').toUpperCase()
      const quantity = Math.min(99, Math.max(1, Number(msg.quantity) || 1))
      if (!COLORS.includes(color)) {
        return send(ws, { type: 'error', message: 'Color inválido' })
      }

      const existing = room.orders.find(
        (o) => o.participantId === participant.id && o.color === color && o.round === room.round,
      )
      if (existing) {
        existing.quantity = quantity
      } else {
        room.orders.push({
          id: `ord-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          participantId: participant.id,
          name: participant.name,
          color,
          quantity,
          round: room.round,
        })
      }
      const toast = {
        id: `toast-${Date.now()}`,
        name: participant.name,
        color,
        quantity,
        round: room.round,
      }
      pushActivity(room, `${participant.name} pidió ${quantity} ${color}`)
      broadcast(room, { type: 'state', state: publicState(room) })
      broadcast(room, { type: 'order_toast', order: toast })
      return
    }

    if (msg.type === 'set_winner') {
      if (participant.role !== 'admin') {
        return send(ws, { type: 'error', message: 'Solo el admin puede declarar ganador' })
      }
      const color = String(msg.color || '').toUpperCase()
      if (!COLORS.includes(color)) {
        return send(ws, { type: 'error', message: 'Color inválido' })
      }
      room.status = 'result'
      room.winningColor = color
      pushActivity(room, `Ganó ${color}`)
      broadcast(room, { type: 'state', state: publicState(room) })
      broadcast(room, { type: 'winner', color, round: room.round })
      return
    }

    if (msg.type === 'close_orders') {
      if (participant.role !== 'admin') return
      room.status = 'closed'
      pushActivity(room, 'Compras cerradas')
      broadcast(room, { type: 'state', state: publicState(room) })
      return
    }

    if (msg.type === 'open_orders') {
      if (participant.role !== 'admin') return
      room.status = 'open'
      room.winningColor = null
      pushActivity(room, 'Compras abiertas')
      broadcast(room, { type: 'state', state: publicState(room) })
      return
    }

    if (msg.type === 'new_round') {
      if (participant.role !== 'admin') return
      room.round += 1
      room.status = 'open'
      room.winningColor = null
      pushActivity(room, `Ronda ${room.round} iniciada`)
      broadcast(room, { type: 'state', state: publicState(room) })
      return
    }

    if (msg.type === 'stream_status') {
      if (participant.role !== 'admin') return
      room.streamActive = Boolean(msg.active)
      if (typeof msg.micMuted === 'boolean') room.micMuted = msg.micMuted
      room.cameraActive = Boolean(msg.cameraActive)
      room.screenActive = Boolean(msg.screenActive)
      broadcast(room, { type: 'state', state: publicState(room) })
      return
    }

    if (msg.type === 'mic') {
      if (participant.role !== 'admin') return
      room.micMuted = Boolean(msg.muted)
      broadcast(room, { type: 'state', state: publicState(room) })
      return
    }

    if (msg.type === 'signal') {
      const target = room.participants.get(msg.to)
      if (!target) return
      send(target.ws, {
        type: 'signal',
        from: participant.id,
        signal: msg.signal,
      })
      return
    }

    if (msg.type === 'request_stream') {
      const admin = [...room.participants.values()].find((p) => p.role === 'admin')
      if (!admin) return
      send(admin.ws, {
        type: 'viewer_ready',
        viewerId: participant.id,
        name: participant.name,
      })
    }
  })

  ws.on('close', () => {
    if (!room || !participant) return
    room.participants.delete(participant.id)
    pushActivity(room, `${participant.name} salió`)
    broadcast(room, { type: 'state', state: publicState(room) })
    if (participant.role === 'admin') {
      room.streamActive = false
      broadcast(room, { type: 'state', state: publicState(room) })
      broadcast(room, { type: 'admin_left' })
    }
  })
})

server.listen(PORT, HOST, () => {
  console.log(`Ludito backend en http://${HOST}:${PORT}`)
  console.log(`Health: http://${HOST}:${PORT}/health`)
})
