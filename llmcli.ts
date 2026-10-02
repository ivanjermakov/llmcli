import {
    BoxRenderable,
    CliRenderer,
    MarkdownRenderable,
    RGBA,
    ScrollBoxRenderable,
    SyntaxStyle,
    TextRenderable,
    TextareaRenderable
} from '@opentui/core'
import { spawn } from 'child_process'
import { readFile } from 'fs/promises'
import { OpenAI } from 'openai'
import type { ChatCompletionChunk, ChatCompletionMessageParam } from 'openai/resources'
import { env, stdin, stdout } from 'process'

const skill = {
    exec: async (cmd: string) => {
        contentBox.add(new TextRenderable(renderer, { content: `$ ${cmd}`, fg: color.cmd }))
        console.debug('cmd', cmd)
        const timeout = new Promise<string>(done => setTimeout(() => done('timeout'), spawnTimeoutMs))
        const child = spawn('docker', ['exec', 'llmcli-sandbox', '/bin/sh', '-c', cmd], {
            stdio: ['ignore', 'pipe', 'pipe']
        })
        let out = ''
        child.stdout.addListener('data', d => (out = out + d))
        child.stderr.addListener('data', d => (out = out + d))
        const exited = new Promise(d => child.on('exit', d))
        const res = await Promise.race([timeout, exited])
        if (res === 'timeout') {
            console.warn('cmd timed out')
            child.kill(9)
            await exited
            contentBox.add(new TextRenderable(renderer, { content: `killed`, fg: color.cmd }))
        } else {
            console.debug('cmd output', out)
            contentBox.add(new TextRenderable(renderer, { content: `${out.length}B command output`, fg: color.cmd }))
        }
        return out
    },
    reason: async (prompt: string) => {
        console.debug('reason prompt', prompt)
        const system = `\
You are a SUBAGENT providing critical thinking and reasoning, given PROMPT by USER.
Output in plain text, omit newlines.
Respond in plain text.
Good response can include:
  - critical thinking questions that need to be addressed
  - ways to gather more information to build a full picture using terminal commands
Question every statement beyond common sense, especially those that lose accuracy with time.
Respond as what USER should do to get closer to solving the problem.
Do not decompose the problem if decompositon is already present in PROMPT.
Do not copy information already present in PROMPT.
Use concise language.
Responses over ${maxReasonSize} bytes will be truncated.
`
        const stream = await client.chat.completions.create({
            model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: prompt }
            ],
            stream: true
        })
        const r = new TextRenderable(renderer, { content: prompt, fg: color.reason })
        contentBox.add(r)

        let out = ''
        for await (const event of stream) {
            const delta = event.choices[0].delta
            if (!delta) continue
            if (delta.content) {
                out += delta.content
                r.content = [prompt, out].join('\n')
            }
        }

        return out
    }
}

const contextSize = () => {
    return messages.map(m => (typeof m.content === 'string' ? m.content.length : 0)).reduce((a, b) => a + b, 0)
}

const formatBytes = (bytes: number) => {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}GB`
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)}MB`
    if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)}KB`
    return `${bytes}B`
}

const addToContext = (message: ChatCompletionMessageParam) => {
    messages.push(message)
    contextSizeText.content = formatBytes(contextSize())
}

const truncate = (out: string, maxSize: number) => {
    return out.length === 0
        ? 'EMPTY'
        : out.length > maxSize
            ? `TRUNCATED (${maxSize}/${out.length})B ${out.slice(0, maxSize)}`
            : out
}

const sendPrompt = async () => {
    statusText.content = 'loading'
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
Command output back to AGENT will be truncated to ${maxStdoutSize} bytes
Redirect output to null if output is not needed
Command executing over ${spawnTimeoutMs}ms will be terminated, AGENT will receive \`TIMEOUT\`.
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
            },
            {
                type: 'function',
                function: {
                    name: 'reason',
                    description: `\
Provides reasoning capabilities.
Use for:
  - problem decomposition into smaller tasks
  - problem space exploration
`,
                    parameters: {
                        type: 'object',
                        properties: {
                            prompt: {
                                type: 'string',
                                description: `\
Small piece of context that needs clarification, decomposition, critical view.
Format prompt as it is your own question.
Plain text, omit newlines.
`
                            }
                        },
                        required: ['prompt'],
                        additionalProperties: false
                    },
                    strict: true
                }
            }
        ]
    })
    statusText.content = 'answering'

    let markdown: MarkdownRenderable | undefined
    let response = ''
    const chunks: ChatCompletionChunk[] = []

    const toolCalls: ChatCompletionChunk.Choice.Delta.ToolCall[] = []
    for await (const event of stream) {
        chunks.push(event)
        const delta = event.choices[0].delta
        if (!delta) continue
        if (delta.content) {
            if (!markdown) {
                markdown = new MarkdownRenderable(renderer, {
                    syntaxStyle: SyntaxStyle.fromStyles({
                        keyword: { fg: RGBA.fromIndex(5) },
                        string: { fg: RGBA.fromIndex(2) },
                        comment: { fg: RGBA.fromIndex(8) },
                        number: { fg: RGBA.fromIndex(3) }
                    }),
                    streaming: true
                })
                contentBox.add(markdown)
            }
            response += delta.content
            markdown.content += delta.content
        }
        if (delta.tool_calls) {
            toolCalls.push(...delta.tool_calls)
        }
    }

    addToContext({ role: 'assistant', content: response })
    console.debug('response', response)

    let halt = response.length > 0
    for (const call of toolCalls) {
        if (call.type === 'function' && call.function && call.function.arguments) {
            halt = false
            switch (call.function.name) {
                case 'exec': {
                    statusText.content = 'executing'
                    const cmd = JSON.parse(call.function.arguments).expression
                    const out = await skill.exec(cmd)
                    addToContext({ role: 'system', content: `$ ${cmd}\n${truncate(out, maxReasonSize)}` })
                    break
                }
                case 'reason': {
                    statusText.content = 'reasoning'
                    const prompt = JSON.parse(call.function.arguments).prompt
                    const out = await skill.reason(prompt)
                    console.debug('reason', out)
                    addToContext({ role: 'assistant', content: truncate(out, maxReasonSize) })
                    break
                }
                default: {
                    console.warn('unknown skill', call.function.name)
                }
            }
        }
    }
    if (!halt) {
        await sendPrompt()
    }
}

const maxStdoutSize = 10000
const maxReasonSize = 10000
const spawnTimeoutMs = 10000
const agentInstructions = `\
You are an autonomous AGENT.
Today is ${new Date()}.
AGENT must not write final answer without having factual proof for every statement.
AGENT must thoroughly search the web at all times.
AGENT must not guess, only output statements confirmed externally.
AGENT must use "reason" skill until clear and complete answer to the problem of USER is obvious from context.
AGENT must use "reason" skill immediately after USER message.
AGENT must use "reason" skill right before giving answer to USER.
AGENT must use "reason" skill until full clear answer to the problem is obvious.
AGENT must not use "reason" skill with the same prompt more than once.
AGENT must not use "reason" skill for already received information.
AGENT must use "exec" skill to utilize full advantage from having internet and unbounded terminal access.
AGENT must be very eager to use "exec" skill.
AGENT must not give up on failures to get to answers quickly, iterate using all available tools.
When faced with contradicting information, AGENT must additionally vefiry it before answering to USER.
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

const color = {
    status: RGBA.fromIndex(7),
    cmd: RGBA.fromIndex(7),
    reason: RGBA.fromIndex(7),
    user: RGBA.fromIndex(3)
}

const renderer = new CliRenderer(stdin, stdout, stdout.columns, stdout.rows, {
    consoleOptions: {
        sizePercent: 100,
        backgroundColor: RGBA.fromValues(0.1, 0.1, 0.1, 1)
    }
})
await renderer.setupTerminal()
renderer.on('resize', console.log)
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
    height: '100%'
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

const inputBox = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row',
    paddingTop: 1
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
    onContentChange: () => {
        renderer.intermediateRender()
    },
    onSubmit: async () => {
        const text = textarea.plainText
        if (text.length === 0) return
        addToContext({ role: 'user', content: text })
        contentBox.add(new TextRenderable(renderer, { content: `> ${text}`, fg: color.user }))
        textarea.clear()
        await sendPrompt()
        statusText.content = 'idle'
    }
})
textarea.focus()
inputBox.add(textarea)

const statusLine = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row',
    gap: 1
})
root.add(statusLine)

const statusText = new TextRenderable(renderer, { width: 10, content: 'idle' })
statusLine.add(statusText)

statusLine.add(new TextRenderable(renderer, { content: model }))

const contextSizeText = new TextRenderable(renderer, { width: 7, content: formatBytes(contextSize()) })
statusLine.add(contextSizeText)

renderer.intermediateRender()
