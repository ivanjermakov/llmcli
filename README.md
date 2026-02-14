# llmcli

REPL for interacting with LLMs from the terminal based on [Groq SDK](https://www.npmjs.com/package/groq-sdk).

## Configuration

Create dir in $XDG_CONFIG_HOME

```
$ tree $XDG_CONFIG_HOME/llmcli
├── instructions.md
└── key
```

`key` contains [Groq SDK API key](https://console.groq.com/keys),
`instructions.md` is a system instructions to init each conversation with the model.

## Credits

- [Groq SDK](https://console.groq.com/docs)
- [Streamdown](https://github.com/day50-dev/Streamdown)
