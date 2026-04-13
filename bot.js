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
const logger = pino({ level: 'fatal' })

const processedMessages = new Set()
const warnedSet = new Set()

let botReady = false
let isBroadcasting = false
let isStarting = false

const HISTORY_FILE = './riwayat_terkirim.txt'

const historySet = new Set(
    fs.existsSync(HISTORY_FILE)
        ? fs.readFileSync(HISTORY_FILE, 'utf-8').split('\n').filter(x => x.trim())
        : []
)

function loadTargets() {
    return Array.from(historySet)
}

function isValidJid(jid) {
    return jid?.endsWith('@s.whatsapp.net') || jid?.endsWith('@lid')
}

function saveTarget(jid) {
    if (!isValidJid(jid)) {
        log('SAVE', `skip invalid ${jid}`)
        return
    }

    if (historySet.has(jid)) {
        log('SAVE', `skip exist ${jid}`)
        return
    }

    historySet.add(jid)
    fs.appendFileSync(HISTORY_FILE, jid + '\n')
    log('SAVE', `added ${jid}`)
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
        log('ERROR', e.message)
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
Style: santai, pendek, gw/lo, tanpa emoji
Balas kayak temen.
Pesan: "${userText}"
`
        })

        return text.replace(/sebagai ai.*\n?/gi, '').trim()
    } catch {
        return "iyaa santai aja"
    }
}

async function generateStatusAI() {
    try {
        const { text } = await generateText({
            model: 'google/gemini-2.5-flash-lite',
            prompt: `
Lu manusia biasa.

Style:
- santai
- pendek
- natural
- tanpa emoji

Bikin status WA yang random (bisa tentang aktivitas, kerja, santai, dll).
`
        })

        return text.replace(/sebagai ai.*\n?/gi, '').trim()
    } catch {
        return "lagi santai aja hari ini"
    }
}

async function generateAntiSlotAI() {
    try {
        const { text } = await generateText({
            model: 'google/gemini-2.5-flash-lite',
            prompt: `
Lu manusia biasa.
Style santai, pendek, natural, tanpa emoji.
Awali dengan minta maaf karena tadi kirim promosi slot.
Lanjutkan himbauan biar gak main slot.
`
        })

        return text.replace(/sebagai ai.*\n?/gi, '').trim()
    } catch {
        return "maaf tadi gw kirim begituan, mending jangan main slot deh"
    }
}

async function generateKenalanAI() {
    try {
        const { text } = await generateText({
            model: 'google/gemini-2.5-flash-lite',
            prompt: `
Lu manusia biasa, nama lu agus, tinggal di jaksel.
Style santai, pendek, natural, gaya bahasa sehari-hari, tanpa emoji.
Ajak kenalan dan minta save kontak.
`
        })

        return text.replace(/sebagai ai.*\n?/gi, '').trim()
    } catch {
        return "kenalan yuk, save nomor gw ya"
    }
}

async function runBroadcast(sock, jid) {

    if (isBroadcasting) {
        await sendWithHuman(sock, jid, "masih jalan")
        return
    }

    isBroadcasting = true

    const targets = loadTargets()

    let sentCount = 0

    for (let i = 0; i < targets.length; i += 3) {

        if (sentCount >= 10) {
            log('BROADCAST', 'limit 10 kena, delay 1 jam')
            await delay(60 * 60 * 1000)
            sentCount = 0
        }

        const batch = targets.slice(i, i + 3)

        for (let t of batch) {

            const msg = await generateKenalanAI()

            log('BROADCAST', `kirim ke ${t}`)

            const ok = await sendWithHuman(sock, t, msg)

            log('BROADCAST', `status ${t} = ${ok}`)

            sentCount++

            await delay(20000 + Math.random() * 35000)
        }

        if (i + 3 < targets.length) {
            log('BROADCAST', 'delay 10 menit')
            await delay(10 * 60 * 1000)
        }
    }

    await sendWithHuman(sock, jid, "selesai")
    isBroadcasting = false
}

async function startBot() {

    if (isStarting) return
    isStarting = true

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    const { version } = await fetchLatestBaileysVersion()

    log('DEBUG', `WA VERSION: ${version}`)

    const sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: Browsers.ubuntu('Chrome'),
    })

    sock.ev.on('creds.update', saveCreds)

    if (!sock.authState.creds.registered) {
        const nomor = await question('Nomor: ')
        const code = await sock.requestPairingCode(nomor)
        console.log('Pairing code:', code)
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update

        log('CONNECTION', JSON.stringify(update))

        if (connection === 'open') {
            log('SYSTEM', 'Connected')
            isStarting = false

            setTimeout(() => {
                botReady = true
                log('SYSTEM', 'Bot ready')
            }, 10000)

            setInterval(async () => {
   		try {
        		if (!botReady) return

        		const statusText = await generateStatusAI()

        		log('STATUS', `kirim: ${statusText}`)

        		await sock.sendMessage('status@broadcast', {text: statusText})

	    	} catch (e) {
        		log('STATUS_ERROR', e.message)
    		}
	    }, 3 * 60 * 60 * 1000)
        }

        if (connection === 'close') {
            log('SYSTEM', 'Closed')

            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                isStarting = false
                startBot()
            }
        }
    })

    sock.ev.on('call', async (calls) => {
        for (let call of calls) {
            const jid = call.from

            log('CALL', `reject ${jid}`)

            await sock.rejectCall(call.id, call.from)

            await sendWithHuman(sock, jid, "jangan telpon ya, chat aja")
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
            const fromMe = msg.key.fromMe

            if (!jid || !text || !botReady) return

            log('MSG', `jid=${jid} fromMe=${fromMe} text=${text}`)

            if (fromMe && isJudol(text)) {

                log('FLOW', 'JUDOL DETECT')

                if (!isValidJid(jid)) {
                    log('FLOW', 'invalid jid')
                    return
                }

                saveTarget(jid)

                if (!warnedSet.has(jid)) {

                    warnedSet.add(jid)

                    const reply = await generateAntiSlotAI()

                    log('FLOW', `send himbauan ${jid}`)

                    await delay(5000)

                    const ok = await sendWithHuman(sock, jid, reply)

                    log('FLOW', `status ${ok}`)
                } else {
                    log('FLOW', 'skip warned')
                }

                return
            }

            if (!fromMe) {

                await delay(15000 + Math.random() * 15000)

                const reply = await generateReplyAI(text)

                await sendWithHuman(sock, jid, reply)
                return
            }

            if (text === '!ping_test') {
                runBroadcast(sock, jid)
            }

        } catch (e) {
            log('ERROR', e.message)
        }
    })
}

startBot()
