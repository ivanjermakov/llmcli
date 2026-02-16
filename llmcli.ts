import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { readFile } from 'fs/promises'
import Groq from 'groq-sdk'
import * as completions from 'groq-sdk/resources/chat/completions'
import { env, exit, stdin, stdout } from 'process'

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
    stdout.write(color.reset)
    const chatCompletion = await groq.chat.completions.create({
        messages,
        model: model,
        temperature: 0.6,
        max_completion_tokens: 4096,
        top_p: 0.95,
        stream: true,
        reasoning_effort: 'default',
        include_reasoning: false,
        stop: null
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
    stdout.write('\n')
    messages.push({ role: 'assistant', content: response })
}

const apiKey = (await readFile(`${env.XDG_CONFIG_HOME}/llmcli/key`)).toString().trim()
const systemInstructions = (await readFile(`${env.XDG_CONFIG_HOME}/llmcli/instructions.md`)).toString().trim()
/**
 * model zoo @link https://docs.google.com/spreadsheets/d/1ykqh8Xi1sL7LKnJn6_rR58SbUAcoJKmVMg7mh_L6CCc/edit?usp=sharing
 */
const model = 'qwen/qwen3-32b'

const messages: completions.ChatCompletionMessageParam[] = [{ role: 'system', content: systemInstructions }]
const groq = new Groq({ apiKey })

stdout.write(`\
${model} \
${color.cyan}^D${color.reset} quit \
${color.cyan}^Q${color.reset} !reset \
${color.cyan}^A${color.reset} !again \
${color.cyan}^N${color.reset} !next
`)

let chunk: Buffer
let prompt = ''

if (stdin.isTTY) stdin.setRawMode(true)
stdin.on('data', async c => {
    chunk = c as Buffer
    switch (chunk.length === 1 && chunk[0]) {
        case 0x11: {
            // ^Q
            messages.splice(1)
            stdout.write(`${color.red}!reset${color.reset}\n`)
            prompt = ''
            rl.prompt()
            break
        }
        case 0x01: {
            // ^A
            messages.push({ role: 'user', content: 'give me alternative answer' })
            stdout.write(`${color.red}!again${color.reset}\n`)
            prompt = ''
            rl.prompt()
            break
        }
        case 0x0e: {
            // ^N
            stdout.write(`${color.red}!next${color.reset}\n`)
            prompt = ''
            messages.push({ role: 'user', content: 'continue' })
            await sendPrompt()
            rl.prompt()
            break
        }
    }
})

const rl = createInterface({
    input: stdin,
    output: stdout,
    prompt: `${color.cyan}> `
})
rl.on('line', line => {
    setTimeout(async () => {
        prompt += line + '\n'
        if (chunk.length === 1 && chunk[0] === 0x0d) {
            messages.push({ role: 'user', content: prompt })
            await sendPrompt()
            prompt = ''
            rl.prompt()
        }
    })
})
rl.on('close', () => {
    exit(0)
})
rl.prompt()
