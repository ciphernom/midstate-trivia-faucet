import { Wallet, MidstateClient, Storage, MidstateUtils } from 'midstate-sdk';
import fs from 'fs/promises';

const PEER = "/ip4/134.199.148.215/tcp/9333/p2p/12D3KooWPbR63SQg1UBLpAMiNngqrRHGM4LaMP8ieAJUxhfw7dxv";

const sessions = {}; 
const queue = [];
let isProcessing = false;

// --- Anti-Spam / Deduplication ---
const seenNonces = new Set();
const seenQueue = [];

function markSeen(nonce) {
    if (seenNonces.has(nonce)) return true; // Already processed!
    
    seenNonces.add(nonce);
    seenQueue.push(nonce);
    
    // Keep memory clean
    if (seenQueue.length > 5000) {
        seenNonces.delete(seenQueue.shift());
    }
    return false;
}

// 100% Dictionary-compliant Trivia
const TRIVIA = [
    { q: "what code is midstate build with ?", a: ["rust"] },
    { q: "what hardware is good for node ?", a: ["pi"] },
    { q: "is midstate pow ?", a: ["yes", "true"] },
    { q: "what is first block ?", a: ["0"] },
    { q: "what is this network ?", a: ["midstate"] }
];

// Reward Tiers mapped to Midstate's binary metric system
const REWARDS = [
    0n,
    100n,       // 1 correct: 100 MDS
    1024n,      // 2 correct: 1 kMDS
    10240n,     // 3 correct: 10 kMDS
    102400n,    // 4 correct: 100 kMDS
    1048576n    // 5 correct: 1 mMDS
];

async function runFaucet() {
    console.log("💧 Starting Midstate Trivia Faucet...");

    let wallet;
    try {
        wallet = await Wallet.restore(new Storage.NodeFSStorage('./faucet_wallet'));
        console.log("✅ Loaded existing faucet wallet.");
    } catch {
        console.log("🆕 Creating new faucet wallet...");
        wallet = await Wallet.create(new Storage.NodeFSStorage('./faucet_wallet'));
    }

    const client = new MidstateClient([PEER]);
    await client.connect();
    
    const p2pNode = client.getP2P().node;
    const myPeerId = p2pNode.peerId.toString();
    console.log(`📡 Connected to network! Faucet PeerID: ${myPeerId}`);

    let addr = Object.keys(wallet.wotsAddrs)[0];
    if (!addr) {
        addr = await wallet.getNewAddress();
    }
    console.log(`\n🏦 Faucet Address: ${addr}`);

    console.log("🔄 Rescanning blockchain to recover change UTXOs...");
    await wallet.sync(client, { rescan: true });
    
    const balance = wallet.getBalance();
    const { value, prefix } = MidstateUtils.formatMDS(balance);
    console.log(`💵 Faucet Balance: ${value} ${prefix}\n`);

    // --- Queue Management ---
    async function processQueue() {
        if (isProcessing) return;
        isProcessing = true;

        while (queue.length > 0) {
            const req = queue.shift();
            
            if (wallet.getBalance() < req.amount + 2000n) {
                console.log("   🔄 Balance appears low. Checking chain for missing change UTXOs...");
                await wallet.sync(client);
            }

            if (wallet.getBalance() < req.amount + 2000n) {
                console.log("   ❌ Faucet empty! Sending 'empty'...");
                await client.sendChat(MidstateUtils.textToIndices("empty"), req.nonce).catch(()=>{});
                continue; 
            }

            try {
                const formatted = MidstateUtils.formatMDS(req.amount);
                console.log(`\n   💸 Initiating transfer of ${formatted.value} ${formatted.prefix} to ${req.address.slice(0, 10)}...`);
                
                // 1. Broadcast the transaction to the Mempool
                await wallet.send(client, req.address, req.amount);
                console.log("   🚀 Reveal broadcasted! Waiting for block confirmation...");
                
                // 2. Poll the chain until our Change UTXO is mined into a block
                let confirmed = false;
                for (let i = 0; i < 40; i++) { // Wait up to ~3.3 minutes
                    await new Promise(r => setTimeout(r, 5000));
                    
                    const syncRes = await wallet.sync(client);
                    
                    if (syncRes.found > 0) {
                        confirmed = true;
                        break;
                    }
                }
                
                if (confirmed) {
                    console.log("   ✅ Transaction fully confirmed in a block!");
                } else {
                    console.log("   ⚠️ Confirmation timed out, but it will likely confirm soon.");
                }
                
                const newBal = MidstateUtils.formatMDS(wallet.getBalance());
                console.log(`   💵 New Faucet Balance: ${newBal.value} ${newBal.prefix}`);

                // 3. Finally broadcast the success message
                await client.sendChat(MidstateUtils.textToIndices("done 🚀"), req.nonce).catch(()=>{});
            } catch (e) {
                console.error("   ❌ Transaction failed:", e.message);
                
                // If it was just a slow block, put them back in the queue and retry!
                if (e.message.includes("Timed out")) {
                    console.log("   ⏳ Network variance (slow block). Retrying in 10 seconds...");
                    queue.unshift(req); // Put their request back at the front of the line
                    await new Promise(r => setTimeout(r, 10000)); 
                    continue; 
                } else {
                    // For all other hard errors, send the error chat
                    await client.sendChat(MidstateUtils.textToIndices("error"), req.nonce).catch(()=>{});
                }
            }
        }
        isProcessing = false;
    }

    // --- Interactive Chatbot Logic ---
    client.onPushEvent(async (event) => {
        if (event.ChatMessage) {
            const msg = event.ChatMessage;
            const sender = msg.sender;
            
            if (sender === myPeerId) return; // Ignore ourselves
            if (markSeen(msg.nonce)) return; // Ignore P2P network duplicates!

            const words = MidstateUtils.indicesToWords(msg.words).split(" ");
            const shortSender = sender.slice(0, 6);
            
            const now = Date.now();
            for (const [peer, session] of Object.entries(sessions)) {
                if (now - session.lastUpdated > 300000) delete sessions[peer];
            }

            const addrAtt = msg.attachments.find(a => a.kind === "address");
            
            if (addrAtt) {
                if (!sessions[sender]) {
                    console.log(`\n💬 [${shortSender}] attached an address. Starting Trivia Game!`);
                    sessions[sender] = { 
                        state: 0, 
                        score: 0,
                        address: addrAtt.value, 
                        lastUpdated: now 
                    };
                    await client.sendChat(MidstateUtils.textToIndices(TRIVIA[0].q), msg.nonce);
                } else {
                    console.log(`💬 [${shortSender}] attached an address but is already playing. Ignoring.`);
                }
                return; 
            }

            if (sessions[sender]) {
                const session = sessions[sender];
                session.lastUpdated = now;
                
                console.log(`💬 [${shortSender}] says: "${words.join(" ")}" (Answering Q${session.state + 1})`);

                const currentTrivia = TRIVIA[session.state];
                const isCorrect = currentTrivia.a.some(ans => words.includes(ans));

                let prefix = "";
                if (isCorrect) {
                    session.score++;
                    prefix = "good . ";
                    console.log(`   ✅ Correct! Current Score: ${session.score}`);
                } else {
                    prefix = "bad . ";
                    console.log(`   ❌ Wrong.`);
                }

                session.state++; 

                if (session.state < TRIVIA.length) {
                    const nextQ = TRIVIA[session.state].q;
                    await client.sendChat(MidstateUtils.textToIndices(prefix + nextQ), msg.nonce);
                } else {
                    if (session.score === 0) {
                        console.log(`   💀 Game over. Score: 0. No reward.`);
                        await client.sendChat(MidstateUtils.textToIndices(prefix + "💀"), msg.nonce);
                    } else {
                        const reward = REWARDS[session.score];
                        const formatted = MidstateUtils.formatMDS(reward);
                        
                        console.log(`   🎉 Game over! Score: ${session.score}/5. Rewarding ${formatted.value} ${formatted.prefix}.`);
                        await client.sendChat(MidstateUtils.textToIndices(prefix + "wait"), msg.nonce);
                        
                        queue.push({ address: session.address, amount: reward, nonce: msg.nonce });
                        processQueue();
                    }
                    delete sessions[sender]; 
                }
            }
        }
    });

    console.log("🎧 Faucet is now listening for requests...");
}

async function initWasm() {
    const buf = await fs.readFile('./node_modules/midstate-sdk/pkg/wasm_wallet_bg.wasm');
    const mod = await WebAssembly.compile(buf);
    await Wallet.init(mod);
    await runFaucet();
}

initWasm().catch(console.error);
