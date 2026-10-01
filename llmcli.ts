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
import type { ChatCompletionMessageParam } from 'openai/resources'
import { env } from 'process'

type Message = {
    role: string
    content: string
}

const sendPrompt = async () => {
    const chatResponse = await client.chat.completions.create({
        model,
        messages: messages as ChatCompletionMessageParam[],
        stream: true
    })

    let r: MarkdownRenderable | undefined
    let response = ''
    let isCommand = false

    for await (const completion of chatResponse) {
        const chunk = completion.choices[0]?.delta?.content
        if (!chunk) continue
        if (response === '') {
            isCommand = chunk.startsWith('[')
            if (!isCommand) {
                r = new MarkdownRenderable(renderer, {
                    syntaxStyle: SyntaxStyle.fromStyles({
                        keyword: { fg: RGBA.fromIndex(5) },
                        string: { fg: RGBA.fromIndex(2) },
                        comment: { fg: RGBA.fromIndex(8) },
                        number: { fg: RGBA.fromIndex(3) }
                    }),
                    streaming: true
                })
                contentBox.add(r)
            }
        }
        response += chunk
        if (r) r.content = response
    }
    messages.push({ role: 'assistant', content: response })
    if (r) console.debug('response', r.content)

    if (isCommand) {
        if (response.startsWith('[exec]')) {
            const cmd: string = JSON.parse(response.replaceAll(/\[exec\]/g, ''))
            contentBox.add(new TextRenderable(renderer, { content: `sh ${cmd}` }))
            console.debug('cmd', cmd)
            const child = spawn('docker', ['exec', 'llmcli-sandbox', '/bin/sh', '-c', cmd], {
                stdio: ['ignore', 'pipe', 'pipe']
            })
            let out = ''
            child.stdout.addListener('data', d => (out = out + d))
            child.stderr.addListener('data', d => (out = out + d))
            await new Promise(d => child.on('exit', d))
            messages.push({ role: 'user', content: out })
            console.debug('cmd output', out)
            contentBox.add(new TextRenderable(renderer, { content: out }))
            sendPrompt()
        } else {
            throw Error(`unknown command response ${response}`)
        }
    }
}

const agentInstructions = `\
You work as an agent.
You have to respond types:
  - user - answer in markdown as usual, just don't start response that can be confused as command
  - command - your response should conform to \`[cmd_name]json\`.
Feel free to use commands to improve response quality, especialy when not certain or need newer info.
Multiple commands can be issued in sequence, forming the loop until the first user response.
Command will only be processed if it is at the very start of your response.
One command per your response.
Available commands:
  - exec, with cmd that will be passed to \`sh -c cmd\`, e.g. \`[exec]"ls -la | wc -l > foo.txt"\`
    All cmds are executed in a sandbox Alpine Linux docker environment with internet, persistent across commands.
    Cmd output (stdout+stderr) will be piped back to you as a first user message after the response.
`
const systemInstructions = (await readFile(`${env.XDG_CONFIG_HOME}/llmcli/instructions.md`)).toString().trim()
const messages: Message[] = [
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

const colorUser = RGBA.fromIndex(3)
const inputBox = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row'
})
root.add(inputBox)
inputBox.add(new TextRenderable(renderer, { content: '> ', fg: colorUser }))

const textarea = new TextareaRenderable(renderer, {
    flexGrow: 1,
    keyBindings: [
        { name: 'return', action: 'submit' },
        { ctrl: true, name: 'j', action: 'newline' }
    ],
    textColor: colorUser,
    onSubmit: async () => {
        const text = textarea.plainText
        if (text.length === 0) return
        messages.push({ role: 'user', content: text })
        contentBox.add(new TextRenderable(renderer, { content: text, fg: colorUser }))
        textarea.clear()
        await sendPrompt()
    }
})
textarea.focus()
inputBox.add(textarea)
