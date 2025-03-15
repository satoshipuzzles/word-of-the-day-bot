const fs = require('fs');
const path = require('path');
const { relayInit, getPublicKey, getEventHash, signEvent } = require('nostr-tools');
const axios = require('axios');

const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol'];
const BLOCKSTREAM_API = 'https://blockstream.info/api/blocks/tip/height';
const OPENAI_API_URL = 'https://api.openai.com/v1/images/generations';

// Get current Bitcoin block height
async function getCurrentBlockHeight() {
  const response = await axios.get(BLOCKSTREAM_API);
  return parseInt(response.data);
}

// Select a random word and definition
async function getRandomWord() {
  const wordsList = JSON.parse(fs.readFileSync('words_list.json', 'utf8'));
  const randomIndex = Math.floor(Math.random() * wordsList.length);
  return wordsList[randomIndex];
}

// Generate image with DALL-E
async function generateImage(word, openaiKey) {
  const response = await axios.post(
    OPENAI_API_URL,
    {
      prompt: `An image representing the word "${word}"`,
      n: 1,
      size: '512x512',
    },
    {
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return response.data.data[0].url;
}

// Publish a Nostr event
async function publishEvent(content, privateKey, tags = []) {
  const event = {
    kind: 1,
    pubkey: getPublicKey(privateKey),
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  };
  event.id = getEventHash(event);
  event.sig = signEvent(event, privateKey);

  for (const url of RELAYS) {
    const relay = relayInit(url);
    await relay.connect();
    await relay.publish(event);
    relay.close();
  }
  return event.id;
}

// Fetch comments replying to an event
async function getComments(eventId) {
  const comments = [];
  for (const url of RELAYS) {
    const relay = relayInit(url);
    await relay.connect();
    const sub = relay.sub([{ kinds: [1], '#e': [eventId] }]);
    sub.on('event', (event) => comments.push(event));
    await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5s
    relay.close();
  }
  return comments;
}

// Determine winners from comments
function determineWinners(comments, correctWord) {
  const winners = new Set();
  for (const comment of comments) {
    const match = comment.content.match(/guess:\s*(\w+)/i);
    if (match && match[1].toLowerCase() === correctWord.toLowerCase()) {
      winners.add(comment.pubkey);
    }
  }
  return Array.from(winners);
}

async function main() {
  const privateKey = process.env.NOSTR_NSEC;
  const openaiKey = process.env.OPENAI_API_KEY;
  const wordsJsonPath = path.join(__dirname, 'words.json');
  let wordsData = { words: [], leaderboard: {} };

  if (fs.existsSync(wordsJsonPath)) {
    wordsData = JSON.parse(fs.readFileSync(wordsJsonPath, 'utf8'));
  }

  const currentHeight = await getCurrentBlockHeight();
  const lastPostedHeight =
    wordsData.words.length > 0
      ? wordsData.words[wordsData.words.length - 1].block_height
      : 0;

  if (currentHeight >= lastPostedHeight + 144) {
    // Handle previous word (if exists)
    if (wordsData.words.length > 0) {
      const previousWord = wordsData.words[wordsData.words.length - 1];
      const comments = await getComments(previousWord.event_id);
      const winners = determineWinners(comments, previousWord.word);
      previousWord.winners = winners;

      // Update leaderboard
      for (const winner of winners) {
        wordsData.leaderboard[winner] = (wordsData.leaderboard[winner] || 0) + 1;
      }

      // Publish reveal event
      const revealContent = `# Word of the Day Reveal\n\nThe word was: **${previousWord.word}**\n\nWinners:\n${winners
        .map((w) => `- nostr:${w}`)
        .join('\n') || 'None'}`;
      await publishEvent(revealContent, privateKey);
    }

    // Post new word
    const { word, definition } = await getRandomWord();
    const imageUrl = await generateImage(word, openaiKey);
    const content = `# Word of the Day\n\n**Definition:** ${definition}\n\n![Image](${imageUrl})\n\nGuess the word by replying with "guess: your_word"`;
    const eventId = await publishEvent(content, privateKey);

    wordsData.words.push({
      block_height: currentHeight,
      word,
      definition,
      image_url: imageUrl,
      event_id: eventId,
      winners: [],
    });

    fs.writeFileSync(wordsJsonPath, JSON.stringify(wordsData, null, 2));
  }
}

main().catch(console.error);
