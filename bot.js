require('dotenv').config()

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    DisconnectReason
} = require('@whiskeysockets/baileys')

const { generateText } = require('ai')
const pino = require('pino')
const fs = require('fs')
const readline = require('readline')

const delay = ms => new Promise(res => setTimeout(res, ms))
const logger = pino({ level: 'silent' })

const processedMessages = new Set()
let botReady = false
let isBroadcasting = false

const HISTORY_FILE = './riwayat_terkirim.txt'

const historySet = new Set(
    fs.existsSync(HISTORY_FILE)
        ? fs.readFileSync(HISTORY_FILE, 'utf-8')
            .split('\n')
            .filter(x => x.trim())
        : []
)

function loadTargets() {
    return Array.from(historySet)
}

function saveTarget(jid) {
    if (!jid.endsWith('@s.whatsapp.net')) return

    if (historySet.has(jid)) {
        log('SAVE', `skip ${jid}`)
        return
    }

    historySet.add(jid)
    fs.appendFileSync(HISTORY_FILE, jid + '\n')

    log('SAVE', `+ ${jid}`)
}

function log(type, msg) {
    const time = new Date().toLocaleTimeString()
    console.log(`[${time}] ${type} : ${msg}`)
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
})
const question = (text) => new Promise(resolve => rl.question(text, resolve))

function getText(msg) {
    return (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.interactiveMessage?.body?.text ||
        ""
    ).trim()
}

function isJudol(text) {
    const t = text.toLowerCase()
    return ['slot','gacor','maxwin','scatter','judi'].some(k => t.includes(k))
}

function isAskingGender(text) {
    const t = text.toLowerCase()
    return t.includes('cewek') || t.includes('cowok')
}

function isAskingAddress(text) {
    const t = text.toLowerCase()
    return t.includes('alamat') || t.includes('tinggal dimana')
}

function isAskingDetailAddress(text) {
    const t = text.toLowerCase()
    return t.includes('jaksel mana') || t.includes('detail')
}

async function simulateTyping(sock, jid, text) {
    await sock.sendPresenceUpdate('composing', jid)
    await delay(800 + text.length * 30)
}

async function sendWithHuman(sock, jid, text) {
    try {
        await simulateTyping(sock, jid, text)
        await sock.sendMessage(jid, { text })
        log('SEND', `→ ${jid}`)
        return true
    } catch (e) {
        log('ERROR', 'send gagal')
        return false
    }
}

async function generateReplyAI(userText) {

    if (isAskingGender(userText)) return "gw cowok, nama gw Agus"
    if (isAskingDetailAddress(userText)) return "kepo amat"
    if (isAskingAddress(userText)) return "gw di jaksel"

    try {
        const { text } = await generateText({
            model: 'google/gemini-2.5-flash-lite',
            prompt: `
Lu manusia biasa.

Style:
- gw / lo
- santai
- pendek
- tanpa emoji

Balas kayak temen.

Pesan:
"${userText}"
`
        })

        return text.replace(/sebagai ai.*\n?/gi, '').trim()

    } catch {
        return "iyaa santai aja"
    }
}

async function generateAntiSlotAI() {
    try {
        const { text } = await generateText({
            model: 'google/gemini-2.5-flash-lite',
            prompt: `
Gaya santai, pendek.

Larangan judi slot, bukan ceramah.
`
        })

        return text.trim()
    } catch {
        return "itu mah gak bener, mending jangan"
    }
}

async function generateNokosPromo() {
    return "butuh nomor buat verifikasi akun? gw biasa pake ini cepet\nhttps://t.me/MochiOtpBot?start=_tgr_q3_dv-4zNDU1"
}

let broadcastIndex = 0

async function runBroadcast(sock, jid) {

    if (isBroadcasting) {
        await sendWithHuman(sock, jid, "masih jalan")
        return
    }

    isBroadcasting = true

    const targets = loadTargets()

    for (; broadcastIndex < targets.length; broadcastIndex++) {

        const t = targets[broadcastIndex]

        const promo = await generateNokosPromo()
        await sendWithHuman(sock, t, promo)

        await delay(5000)

        // tiap 3 kirim → pause 1 jam
        if ((broadcastIndex + 1) % 3 === 0) {
            log('WAIT', '1 jam...')
            await delay(60 * 60 * 1000)
        }
    }

    broadcastIndex = 0
    isBroadcasting = false

    await sendWithHuman(sock, jid, "broadcast selesai")
}

let isStarting = false

async function startBot() {

    if (isStarting) return
    isStarting = true

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: Browsers.ubuntu('Chrome'),
        keepAliveIntervalMs: 20000
    })

    sock.ev.on('creds.update', saveCreds)

    if (!sock.authState.creds.registered) {
        const nomor = await question('Nomor (628xxx): ')
        const code = await sock.requestPairingCode(nomor)
        console.log('Pairing code:', code)
    }

    sock.ev.on('connection.update', async (update) => {

        log('CONNECTION_DEBUG', JSON.stringify(update))

        const { connection, lastDisconnect } = update

        if (connection === 'open') {
            log('SYSTEM', 'Connected')
            isStarting = false

            setTimeout(() => {
                botReady = true
                log('SYSTEM', 'Bot ready')

                // lanjut broadcast kalau sebelumnya kepotong
                if (isBroadcasting) {
                    log('SYSTEM', 'Resume broadcast...')
                    runBroadcast(sock, Object.keys(sock.chats)[0])
                }

            }, 5000)
        }

        if (connection === 'close') {
            log('SYSTEM', 'Connection closed')

            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                log('SYSTEM', 'Reconnect...')
                isStarting = false
                startBot()
            }
        }
    })

    sock.ev.on('call', async (calls) => {
        for (let c of calls) {
            if (c.status === 'offer') {
                await sock.rejectCall(c.id, c.from)
                await sendWithHuman(sock, c.from, "jangan telpon ya, chat aja")
                log('CALL', `Rejected ${c.from}`)
            }
        }
    })

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0]
            if (!msg || !msg.message) return

            if (processedMessages.has(msg.key.id)) return
            processedMessages.add(msg.key.id)

            const jid = msg.key.remoteJid
            const text = getText(msg)
            const isFromMe = msg.key.fromMe

            if (!jid || !text) return
            if (!botReady) return

            log('DEBUG', `JID: ${jid}`)
            log('DEBUG', `FROM_ME: ${isFromMe}`)
            log('DEBUG', `TEXT: ${text}`)

            if (isFromMe && isJudol(text) && jid.endsWith('@s.whatsapp.net')) {

                saveTarget(jid)

                if (Math.random() > 0.5) return

                const reply = await generateAntiSlotAI()

                await delay(5000)
                await sendWithHuman(sock, jid, reply)
                return
            }

            if (!isFromMe) {

                await delay(15000 + Math.random() * 15000)

                const reply = await generateReplyAI(text)

                await sendWithHuman(sock, jid, reply)
                return
            }

            if (text === '!ping_test') {
                broadcastIndex = 0
                runBroadcast(sock, jid)
            }

        } catch (err) {
            log('ERROR', err.message)
        }
    })
}

startBot()
