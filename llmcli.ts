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

    let r!: MarkdownRenderable
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
                    streaming: true,
                    paddingBottom: 1
                })
                contentBox.add(r)
            }
        }
        response += chunk
        if (!isCommand) r.content = response
    }
    messages.push({ role: 'assistant', content: response })
    if (!isCommand) console.debug('response', r.content)

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
Available commands:
  - exec, with cmd that will be passed to \`sh -c cmd\`, e.g. \`[exec]"ls -la | wc -l > foo.txt"\`
    All cmds are executed in a sandbox Alpine Linux docker environment with internet, persistent across commands.
    Cmd output (stdout+stderr) will be piped back to you as a first user message after the response.
Feel free to use commands to improve the final response to the user.
Multiple commands can be issued in sequence, forming the loop until the first user response
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

const renderer = await createCliRenderer({})
renderer.keyInput.on('keypress', key => {
    if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key.name)) {
        contentBox.handleKeyPress(key)
        key.preventDefault()
    }
    if (key.name === 'f12') {
        renderer.console.toggle()
    }
})
const root = renderer.root

const contentBox = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    stickyScroll: true,
    stickyStart: 'bottom',
    contentOptions: {
        flexDirection: 'column',
        justifyContent: 'flex-end'
    }
})
root.add(contentBox)

const colorUser = RGBA.fromIndex(3)
const inputBox = new BoxRenderable(renderer, {
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
    textColor: colorUser
})
textarea.onSubmit = async () => {
    const text = textarea.plainText
    if (text.length === 0) return
    messages.push({ role: 'user', content: text })
    contentBox.add(new TextRenderable(renderer, { content: text, paddingBottom: 1, fg: colorUser }))
    textarea.clear()
    await sendPrompt()
}
textarea.focus()
inputBox.add(textarea)
