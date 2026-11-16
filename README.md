# Pi Extensions

Add-ons that make the Pi coding assistant work better, built by Hugo Lopes.

[Pi](https://pi.dev) is an AI assistant that reads, writes and fixes code from a terminal window. An extension adds one feature to Pi. Install only the extensions you want.

## What each extension does

| Extension                                        | What it does for you                                                                                      | Can I install it? |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------- |
| [pi-context-kit](packages/pi-context-kit#readme) | Keeps long conversations with Pi clear. Pi puts old, unneeded text aside, so it keeps track of your work. | Yes               |
| [pi-claude-pro](packages/pi-claude-pro#readme)   | Lets Pi use your Claude Pro, Max or Ultra plan. You do not need a separate Anthropic API key.             | Yes               |
| [pi-onlooker](packages/pi-onlooker#readme)       | A second AI checks Pi's work while it runs, and tells Pi when something is wrong.                         | Not yet           |

## Before you start

You need Pi, and an account with an AI provider that Pi supports, such as Anthropic or OpenAI. If Pi already works on your computer, go to [Install an extension](#install-an-extension).

1. Open a terminal window:
   - macOS: press <kbd>Cmd</kbd> + <kbd>Space</kbd>, type `Terminal`, then press <kbd>Enter</kbd>.
   - Windows: press the <kbd>Windows</kbd> key, type `PowerShell`, then press <kbd>Enter</kbd>.
   - Linux: open the Terminal application.
2. Copy the line for your computer, paste it into the terminal, then press <kbd>Enter</kbd>. This is the official Pi installer.

   macOS or Linux:

   ```bash
   curl -fsSL https://pi.dev/install.sh | sh
   ```

   Windows:

   ```shell
   powershell -c "irm https://pi.dev/install.ps1 | iex"
   ```

3. Type `pi`, then press <kbd>Enter</kbd>. Pi starts.
4. In Pi, type `/login`, press <kbd>Enter</kbd>, then follow the steps to connect your AI account.

## Install an extension

1. Quit Pi if it is open: press <kbd>Ctrl</kbd> + <kbd>C</kbd> two times.
2. In the terminal, type the line for the extension you want, then press <kbd>Enter</kbd>:

   ```bash
   pi install npm:pi-context-kit
   ```

   ```bash
   pi install npm:pi-claude-pro    # needs a Claude Pro, Max or Ultra plan
   ```

3. Type `pi`, then press <kbd>Enter</kbd>. The extension is now active.
4. Open the extension's page from the [table above](#what-each-extension-does) to learn what to do next.

To see which extensions you have, type `pi list`.

## Update or remove an extension

Quit Pi first. Then type one of these lines, with the name of your extension, and press <kbd>Enter</kbd>:

```bash
pi update npm:pi-context-kit    # get the newest version
pi remove npm:pi-context-kit    # remove the extension
```

Start Pi again to use the change.

## Good to know

- pi-context-kit asks your AI model for summaries, and pi-onlooker asks a second model for reviews. These extra requests count against your plan or your bill. Read the **Limits** section of each extension page.
- pi-claude-pro is not made or supported by Anthropic. Read its **Limits** section before you use it.
- pi-onlooker is not released yet. Developers can try it from a copy of this project: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Get help

If something does not work, [open an issue](https://github.com/HugoLopes45/pi-extensions/issues). Tell us which extension you use, what you did and what you saw. Type `pi --version` to find your Pi version, and add it. Do not include passwords, API keys or private conversations.

To report a security problem, read [SECURITY.md](SECURITY.md).

## For developers

[CONTRIBUTING.md](CONTRIBUTING.md) explains how to build, test and release the extensions. Each extension lives in `packages/<name>/` with its own README, changelog, license, source and tests.

## Author

Built by [Hugo Lopes](https://github.com/HugoLopes45), a senior frontend developer based in Paris, passionate about AI and agent harnesses.
