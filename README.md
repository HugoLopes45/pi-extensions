# Pi Extensions

Personal extensions for the [Pi](https://pi.dev) coding agent, built and maintained by Hugo Lopes for his own work. Each extension installs on its own.

> **Security:** Pi extensions run with your full system permissions and can execute any code. Install only extensions you trust, and read their source if you can.

## Extensions

| Extension                                        | What it does                                                       | Install                         |
| ------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------- |
| [pi-context-kit](packages/pi-context-kit#readme) | Keeps long sessions clear by putting old, unneeded context aside.  | `pi install npm:pi-context-kit` |
| [pi-claude-pro](packages/pi-claude-pro#readme)   | Lets Pi use a Claude Pro, Max or Ultra plan instead of an API key. | `pi install npm:pi-claude-pro`  |
| [pi-onlooker](packages/pi-onlooker#readme)       | A second model checks the agent's work while it runs.              | `pi install npm:pi-onlooker`    |
| [pi-hl-lsp](packages/pi-hl-lsp#readme)           | Navigate code and apply edits from configured language servers.    | Not released yet                |
| [pi-hl-dap](packages/pi-hl-dap#readme)           | Configured Debug Adapter Protocol sessions for Pi.                 | Not released yet                |

Read an extension's README before you install it. It lists what the extension needs and its limits.

## Get started

If Pi already works on your computer, go to [Install an extension](#install-an-extension).

1. Open a terminal window:
   - macOS: press <kbd>Cmd</kbd> + <kbd>Space</kbd>, type `Terminal`, then press <kbd>Enter</kbd>.
   - Windows: press the <kbd>Windows</kbd> key, type `PowerShell`, then press <kbd>Enter</kbd>.
   - Linux: open your terminal application.
2. Copy the official Pi installer line for your computer, paste it into the terminal, then press <kbd>Enter</kbd>.

   macOS or Linux:

   ```bash
   curl -fsSL https://pi.dev/install.sh | sh
   ```

   Windows:

   ```shell
   powershell -c "irm https://pi.dev/install.ps1 | iex"
   ```

3. Type `pi`, then press <kbd>Enter</kbd>. Pi starts.
4. In Pi, type `/login`, press <kbd>Enter</kbd>, then follow the steps to connect your AI provider account or API key.

## Install an extension

1. Quit Pi if it is open: press <kbd>Ctrl</kbd> + <kbd>C</kbd> two times.
2. Copy the install line of the extension from the [Extensions](#extensions) table, paste it into the terminal, then press <kbd>Enter</kbd>.
3. Type `pi`, then press <kbd>Enter</kbd>. The extension is now active.

## Manage your extensions

Quit Pi first. Then type one of these lines and press <kbd>Enter</kbd>. Replace `<extension>` with the name from the table, for example `pi-context-kit`.

```bash
pi list                         # show the installed extensions
pi update npm:<extension>       # get the newest version
pi remove npm:<extension>       # remove the extension
```

Start Pi again to use the change.

## Get help

If something does not work, [open an issue](https://github.com/HugoLopes45/pi-extensions/issues). Tell us which extension you use, what you did and what you saw, and add your Pi version: type `pi --version` to find it. Do not include passwords, API keys or private conversations.

To report a security problem, read [SECURITY.md](SECURITY.md).

## Contributing

Each extension lives in `packages/<extension>/` with its own README, changelog, license, source and tests. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to build, test and release an extension.

## Author

Built by [Hugo Lopes](https://github.com/HugoLopes45), a senior frontend developer based in Paris, passionate about AI and agent harnesses.
