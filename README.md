<h1 align="center">
  <img src="docs/logo.svg" width="460" alt="LaTeX Review Skill">
</h1>

<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

Review an agent's LaTeX edits directly in the PDF. Accept, reject, or comment; feedback returns to the agent through the CLI.

![LaTeX review demo](docs/demo.gif)

## Install

Requires macOS or Linux, Node.js 22.22+, Git, and TeX Live or MacTeX with `latexmk` and `synctex`.

```sh
npx skills add cu1ch3n/latex-review-skill -g
```

## Use

Open your LaTeX Git repository in the agent and ask:

> Use latex-review-skill to tighten Section 3 while preserving its technical meaning. Let me review the changes before they reach the manuscript.

Open the review link the agent provides. Inspect the PDF and source diff, then accept, reject, or comment. Accepted edits merge into your working tree without creating a commit.

- Select and copy PDF text; use the minimap to jump between changes.
- Say **“accept all”** to apply pending edits through the CLI.
- Keep the agent session running; completing the round returns your feedback automatically.

[Reference](docs/reference.md) · [Agent instructions](SKILL.md) · [Tests and corpus](docs/corpus.md) · [MIT License](LICENSE)
