# Midstate Trivia Faucet

A fun trivia faucet bot for the Midstate network.

Players attach their address and answer 5 questions. Correct answers earn MDS rewards:
- 1 correct → 100 MDS
- 2 correct → 1 kMDS
- 3 correct → 10 kMDS
- 4 correct → 100 kMDS
- 5 correct → 1 mMDS

## Features
- Anti-spam & deduplication
- Automatic queue processing
- Real-time P2P chat interaction
- Uses official `midstate-sdk`

## Setup

```bash
npm install
node faucet.js
```

## Requirements
- Node.js
- midstate-sdk
- A funded faucet wallet

## License
GNU GPL v3
