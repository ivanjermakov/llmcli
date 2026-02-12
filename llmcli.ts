import { Recoverable, start } from 'repl'
import { readFile } from 'fs/promises'
import Groq from 'groq-sdk'
import * as completions from 'groq-sdk/resources/chat/completions'

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

    let response = ''
    for await (const completion of chatCompletion) {
        const chunk = completion.choices[0]?.delta?.content
        if (!chunk) continue
        process.stdout.write(chunk)
        response += chunk
    }
    process.stdout.write('\n')
    messages.push({ role: 'assistant', content: response })
}

const apiKey = (await readFile(`${process.env.XDG_CONFIG_HOME}/llmcli/key`)).toString().trim()
const systemInstructions = (await readFile(`${process.env.XDG_CONFIG_HOME}/llmcli/instructions.md`)).toString().trim()
const model = 'llama-3.1-8b-instant'

const messages: completions.ChatCompletionMessageParam[] = [{ role: 'system', content: systemInstructions }]
const groq = new Groq({ apiKey })

let lastKey = 0
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on('data', buf => {
    if (typeof buf === 'string') return
    lastKey = buf[buf.length - 1]
})

console.info(`llmcli | ${model}`)
let prompt = ''
start({
    prompt: '> ',
    ignoreUndefined: true,
    eval: async (cmd, _context, _filename, callback) => {
        setTimeout(async () => {
            prompt += cmd
            if (lastKey === 0x0a) return Recoverable

            messages.push({ role: 'user', content: prompt })
            await sendPrompt()
            callback(null, undefined)
            prompt = ''
            return undefined
        })
    }
})
