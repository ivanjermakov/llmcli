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
import { readFile } from 'fs/promises'
import { OpenAI } from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources'
import { env } from 'process'

type Message = {
    role: string
    content: string
}

const sendPrompt = async () => {
    const message = new MarkdownRenderable(renderer, {
        syntaxStyle: SyntaxStyle.fromStyles({
            keyword: { fg: RGBA.fromIndex(5) },
            string: { fg: RGBA.fromIndex(2) },
            comment: { fg: RGBA.fromIndex(8) },
            number: { fg: RGBA.fromIndex(3) }
        }),
        streaming: true,
        paddingBottom: 1
    })
    contentBox.add(message)
    let response = ''

    const chatResponse = await client.chat.completions.create({
        model,
        messages: messages as ChatCompletionMessageParam[],
        stream: true
    })

    for await (const completion of chatResponse) {
        const chunk = completion.choices[0]?.delta?.content
        if (!chunk) continue
        response += chunk
        message.content = response
    }
    messages.push({ role: 'assistant', content: response })
}

const systemInstructions = (await readFile(`${env.XDG_CONFIG_HOME}/llmcli/instructions.md`)).toString().trim()
const messages: Message[] = [{ role: 'system', content: systemInstructions }]

const model = 'gemma4:31b'
const client = new OpenAI({
    baseURL: 'https://ollama.com/v1',
    apiKey: (await readFile(`${env.XDG_CONFIG_HOME}/llmcli/ollama`)).toString().trim()
})

const renderer = await createCliRenderer({})
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
renderer.keyInput.on('keypress', key => {
    if (['h', 'j', 'k', 'l'].includes(key.name)) return
    if (contentBox.handleKeyPress(key)) {
        key.preventDefault()
    }
})

const inputBox = new BoxRenderable(renderer, {
    flexDirection: 'row'
})
root.add(inputBox)
inputBox.add(new TextRenderable(renderer, { content: '> ' }))

const textarea = new TextareaRenderable(renderer, {
    flexGrow: 1,
    keyBindings: [
        { name: 'return', action: 'submit' },
        { ctrl: true, name: 'j', action: 'newline' }
    ],
    tabIndicator: '>'
})
textarea.onSubmit = async () => {
    const text = textarea.plainText
    if (text.length === 0) return
    messages.push({ role: 'user', content: text })
    contentBox.add(new TextRenderable(renderer, { content: text, paddingBottom: 1 }))
    textarea.clear()
    await sendPrompt()
}
textarea.focus()
inputBox.add(textarea)
