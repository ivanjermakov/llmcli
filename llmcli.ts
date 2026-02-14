import { spawn } from 'child_process'
import { Recoverable, start } from 'repl'
import { readFile } from 'fs/promises'
import Groq from 'groq-sdk'
import * as completions from 'groq-sdk/resources/chat/completions'

const color = {
    black: `\x1b[30m`,
    red: `\x1b[31m`,
    green: `\x1b[32m`,
    yellow: `\x1b[33m`,
    blue: `\x1b[34m`,
    magenta: `\x1b[35m`,
    cyan: `\x1b[36m`,
    white: `\x1b[37m`,
    reset: '\x1b[0m'
}

const sendPrompt = async () => {
    const chatCompletion = await groq.chat.completions.create({
        messages,
        model: model,
        temperature: 1,
        max_completion_tokens: 2048,
        top_p: 1,
        stream: true,
        stop: null,
        response_format: { type: 'text' }
    })

    const child = spawn('streamdown', [], { stdio: ['pipe', 'inherit', 'inherit'] })
    let response = ''
    for await (const completion of chatCompletion) {
        const chunk = completion.choices[0]?.delta?.content
        if (!chunk) continue
        response += chunk
        child.stdin.write(chunk)
    }
    child.stdin.end()
    await new Promise(d => child.on('exit', d))
    process.stdout.write('\n')
    messages.push({ role: 'assistant', content: response })
}

const apiKey = (await readFile(`${process.env.XDG_CONFIG_HOME}/llmcli/key`)).toString().trim()
const systemInstructions = (await readFile(`${process.env.XDG_CONFIG_HOME}/llmcli/instructions.md`)).toString().trim()
const model = 'openai/gpt-oss-120b'

const messages: completions.ChatCompletionMessageParam[] = [{ role: 'system', content: systemInstructions }]
const groq = new Groq({ apiKey })

let lastKey = 0
let paste = false
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on('data', async buf => {
    if (typeof buf === 'string') return
    paste = buf.length > 1
    lastKey = buf[buf.length - 1]
    switch (buf.length === 1 && lastKey) {
        case 0x11: {
            // ^Q
            process.stdout.write(color.red)
            server.write('!reset\n')
            break
        }
        case 0x01: {
            // ^A
            process.stdout.write(color.red)
            server.write('!again\n')
            break
        }
        case 0x0e: {
            // ^N
            process.stdout.write(color.red)
            server.write('!next\n')
            break
        }
    }
})

process.stdout.write(`\
${model} \
${color.cyan}^D${color.reset} quit \
${color.cyan}^Q${color.reset} !reset \
${color.cyan}^A${color.reset} !again \
${color.cyan}^N${color.reset} !next
`)
let prompt = ''
const server = start({
    prompt: `> ${color.cyan}`,
    ignoreUndefined: true,
    eval: async (cmd, _context, _filename, callback) => {
        setTimeout(async () => {
            prompt += cmd
            if (lastKey === 0x0a || paste) return Recoverable

            process.stdout.write(color.reset)
            if (prompt.startsWith('!again')) {
                messages.push({ role: 'user', content: 'give me alternative answer' })
                await sendPrompt()
            } else if (prompt.startsWith('!reset')) {
                messages.splice(1)
            } else if (prompt.startsWith('!next')) {
                messages.push({ role: 'user', content: 'continue' })
                await sendPrompt()
            } else {
                messages.push({ role: 'user', content: prompt })
                await sendPrompt()
            }

            callback(null, undefined)
            prompt = ''
            return undefined
        })
    }
})
