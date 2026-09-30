# llmcli

Terminal agent client

## Configuration

Create dir in $XDG_CONFIG_HOME

```
$ tree $XDG_CONFIG_HOME/llmcli
├── instructions.md
├── ollama
└── groq
```

`ollama/groq` contains API key,
`instructions.md` is a system instructions to init each conversation with the model.
