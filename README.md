# Project Name

> One-line pitch: what it does and who it is for.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (2026).

**Demo video:** _add YouTube link (under 3 minutes)_
**Live demo:** _add hosted URL, or see [Run it locally](#run-it-locally)_

---

## The problem

_Who has this problem, how often, and what it costs them today. Be specific about the audience._

## What it does

_Two or three sentences on the solution, then the key features:_

- Feature 1
- Feature 2
- Feature 3

## How it uses PayPal

| PayPal capability | How we use it |
| --- | --- |
| _e.g. Orders API / Agent Toolkit / MCP server_ | _what it does in the product_ |

## How it uses AI

| AI tool / model | How we use it |
| --- | --- |
| _e.g. model name or provider_ | _what it does in the product_ |

## Architecture

_Short description or a diagram (put images in `docs/images/`)._

```
User -> Frontend -> Backend -> AI model
                          \-> PayPal (sandbox)
```

## Tech stack

- Runtime: Node.js 20.6+
- _add frameworks, libraries and sponsor tools used_

## Run it locally

### Prerequisites

- Node.js 20.6 or newer
- A PayPal Developer account with a sandbox app ([developer.paypal.com](https://developer.paypal.com))
- An API key for the AI provider you use

### Setup

```bash
git clone <your-repo-url>
cd <repo-folder>
npm install
cp .env.example .env
# then fill in .env with your sandbox credentials and AI key
```

### Check your PayPal sandbox credentials

```bash
npm run check:sandbox
```

You should see `PayPal sandbox OK`.

### Start the app

```bash
npm start
```

### Test accounts

_Sandbox buyer login for judges (email and password), or how to create one._

## Project structure

```
.
├── src/          # application code
├── scripts/      # helper scripts (sandbox check, seeding)
├── docs/images/  # screenshots and diagrams for README and Devpost
├── .env.example  # environment variables template (copy to .env)
└── LICENSE
```

## What's next

_Where the project goes after the hackathon._

## Team

- _Name - role_

## License

[MIT](LICENSE)
