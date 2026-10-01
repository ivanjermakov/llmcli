import {
    BoxRenderable,
    MarkdownRenderable,
    RGBA,
    ScrollBoxRenderable,
    SyntaxStyle,
    TextRenderable,
    TextareaRenderable,
    createCliRenderer
} from '@opentui/core'
import { spawn } from 'child_process'
import { readFile } from 'fs/promises'
import { OpenAI } from 'openai'
import type { ChatCompletionChunk, ChatCompletionMessageParam } from 'openai/resources'
import { env } from 'process'

const sendPrompt = async () => {
    const stream = await client.chat.completions.create({
        model,
        messages,
        stream: true,
        tools: [
            {
                type: 'function',
                function: {
                    name: 'exec',
                    description: `\
Execute a bash command and read output
All commands are executed in a persistent sandbox Alpine Linux docker environment with internet access.
Command output (stdout+stderr) will be piped back to AGENT.
Output might be 0 bytes, in which case AGENT will receive \`EMPTY\`.
Sending full command output back to AGENT is very expensive:
  * it will be truncated to ${maxStdoutSize} bytes
  * redirect output to null if output is not needed
AGENT must extensively use it for:
  - reading offline info: cat, ls, etc.
  - reading online info: curl, google-chrome, playwright, etc.
  - reading current date and time
  - finding location
  - writing programming scripts
`,
                    parameters: {
                        type: 'object',
                        properties: {
                            expression: {
                                type: 'string',
                                description: 'Must be a valid bash expression that will be executed using `bash -c cmd'
                            }
                        },
                        required: ['expression'],
                        additionalProperties: false
                    },
                    strict: true
                }
            }
        ]
    })

    const markdown = new MarkdownRenderable(renderer, {
        syntaxStyle: SyntaxStyle.fromStyles({
            keyword: { fg: RGBA.fromIndex(5) },
            string: { fg: RGBA.fromIndex(2) },
            comment: { fg: RGBA.fromIndex(8) },
            number: { fg: RGBA.fromIndex(3) }
        }),
        streaming: true
    })
    contentBox.add(markdown)
    let response = ''
    const chunks: ChatCompletionChunk[] = []

    const toolCalls: ChatCompletionChunk.Choice.Delta.ToolCall[] = []
    for await (const event of stream) {
        chunks.push(event)
        const delta = event.choices[0].delta
        if (!delta) continue
        if (delta.content) {
            response += delta.content
            markdown.content += delta.content
        }
        if (delta.tool_calls) {
            toolCalls.push(...delta.tool_calls)
        }
    }

    messages.push({ role: 'assistant', content: response })
    console.debug('response', response)

    for (const call of toolCalls) {
        if (call.type === 'function' && call.function?.name === 'exec' && call.function.arguments) {
            const cmd = JSON.parse(call.function.arguments).expression
            contentBox.add(new TextRenderable(renderer, { content: `$ ${cmd}`, fg: color.status }))
            console.debug('cmd', cmd)
            const child = spawn('docker', ['exec', 'llmcli-sandbox', '/bin/sh', '-c', cmd], {
                stdio: ['ignore', 'pipe', 'pipe']
            })
            let out = ''
            child.stdout.addListener('data', d => (out = out + d))
            child.stderr.addListener('data', d => (out = out + d))
            await new Promise(d => child.on('exit', d))
            console.debug('cmd output', out)
            contentBox.add(new TextRenderable(renderer, { content: `${out.length}B command output`, fg: color.status }))
            messages.push({
                role: 'system',
                content:
                    out.length === 0
                        ? 'EMPTY'
                        : out.length > maxStdoutSize
                            ? `TRUNCATED (${maxStdoutSize}/${out.length})B ${out.slice(0, maxStdoutSize)}`
                            : out
            })
        }
    }
    if (messages.at(-1)?.role === 'system') {
        await sendPrompt()
    }
}

const maxStdoutSize = 1000
const agentInstructions = `\
You are the AGENT.
The USER tasks AGENT with solving problems and answering questions.
`
const systemInstructions = (await readFile(`${env.XDG_CONFIG_HOME}/llmcli/instructions.md`)).toString().trim()
const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: agentInstructions },
    { role: 'system', content: systemInstructions }
]

const model = 'gemma4:31b'
const client = new OpenAI({
    baseURL: 'https://ollama.com/v1',
    apiKey: (await readFile(`${env.XDG_CONFIG_HOME}/llmcli/ollama`)).toString().trim()
})

const renderer = await createCliRenderer({
    consoleOptions: {
        sizePercent: 100,
        backgroundColor: RGBA.fromValues(0.1, 0.1, 0.1, 1)
    }
})
renderer.keyInput.on('keypress', key => {
    if (['pageup', 'pagedown'].includes(key.name)) {
        contentBox.handleKeyPress(key)
        key.preventDefault()
    }
    if (key.name === 'f12') {
        renderer.console.toggle()
    }
})
const root = new BoxRenderable(renderer, {
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    gap: 1
})
renderer.root.add(root)

const contentBox = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    flexBasis: 0,
    stickyScroll: true,
    stickyStart: 'bottom',
    viewportCulling: true,
    contentOptions: {
        flexDirection: 'column',
        justifyContent: 'flex-end',
        gap: 1
    }
})
root.add(contentBox)

const color = {
    status: RGBA.fromIndex(0),
    user: RGBA.fromIndex(3)
}
const inputBox = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row'
})
root.add(inputBox)
inputBox.add(new TextRenderable(renderer, { content: '> ', fg: color.user }))

const textarea = new TextareaRenderable(renderer, {
    flexGrow: 1,
    keyBindings: [
        { name: 'return', action: 'submit' },
        { ctrl: true, name: 'j', action: 'newline' }
    ],
    textColor: color.user,
    onSubmit: async () => {
        const text = textarea.plainText
        if (text.length === 0) return
        messages.push({ role: 'user', content: text })
        contentBox.add(new TextRenderable(renderer, { content: text, fg: color.user }))
        textarea.clear()
        await sendPrompt()
    }
})
textarea.focus()
inputBox.add(textarea)
