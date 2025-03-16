const fs = require('fs');
const path = require('path');
const { relayInit, getPublicKey, getEventHash, signEvent } = require('nostr-tools');
const axios = require('axios');

async function main() {
  const state = JSON.parse(fs.readFileSync('words.json', 'utf8'));
  const current_block = await getCurrentBlockHeight();

  if (current_block >= state.next_word_block) {
    const word = await getRandomWord();
    const image_url = await generateAndSaveImage(word);
    const event_id = await postImageEvent(image_url);
    state.words.push({
      word,
      image_url,
      image_event_id: event_id,
      posted_at_block: current_block,
      next_hint_block: current_block + 21,
      hints_posted: 0,
      winner: null
    });
    state.next_word_block += 144;
  }

  for (const word of state.words) {
    if (word.winner === null) {
      if (current_block >= word.next_hint_block) {
        const hint = await getHint(word.word);
        await postHintEvent(word.image_event_id, hint);
        word.hints_posted += 1;
        word.next_hint_block += 21;
      }
      const replies = await getReplies(word.image_event_id, state.last_checked_time);
      for (const reply of replies) {
        if (reply.content.toLowerCase().includes(word.word.toLowerCase())) {
          word.winner = reply.pubkey;
          await postWinnerEvent(word.image_event_id, word.word, reply.pubkey);
          state.leaderboard[reply.pubkey] = (state.leaderboard[reply.pubkey] || 0) + 1;
          break;
        }
      }
    }
  }

  state.last_checked_time = Math.floor(Date.now() / 1000);
  fs.writeFileSync('words.json', JSON.stringify(state, null, 2));
}

async function getCurrentBlockHeight() {
  const response = await axios.get('https://blockchain.info/q/getblockcount');
  return parseInt(response.data);
}

async function getRandomWord() {
  const response = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'Give me a random word.' }]
  }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } });
  return response.data.choices[0].message.content.trim();
}

async function generateAndSaveImage(word) {
  const response = await axios.post('https://api.openai.com/v1/images/generations', {
    prompt: `An image of ${word}`,
    n: 1,
    size: '512x512'
  }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } });
  const image_url = response.data.data[0].url;
  const filename = `word-${Date.now()}.png`;
  const image_path = path.join('images', filename);
  if (!fs.existsSync('images')) fs.mkdirSync('images');
  const writer = fs.createWriteStream(image_path);
  const image_response = await axios.get(image_url, { responseType: 'stream' });
  image_response.data.pipe(writer);
  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
  return `${process.env.GITHUB_PAGES_URL}images/${filename}`;
}

async function postImageEvent(image_url) {
  const content = `![image](${image_url})`;
  const event = {
    kind: 1,
    pubkey: getPublicKey(process.env.NOSTR_NSEC),
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content
  };
  event.id = getEventHash(event);
  event.sig = signEvent(event, process.env.NOSTR_NSEC);
  const relay = relayInit('wss://relay.damus.io');
  await relay.connect();
  await relay.publish(event);
  relay.close();
  return event.id;
}

async function getHint(word) {
  const response = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4',
    messages: [{ role: 'user', content: `Give me a hint for the word "${word}" without saying the word.` }]
  }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } });
  return response.data.choices[0].message.content.trim();
}

async function postHintEvent(image_event_id, hint) {
  const content = `Hint: ${hint}`;
  const event = {
    kind: 1,
    pubkey: getPublicKey(process.env.NOSTR_NSEC),
    created_at: Math.floor(Date.now() / 1000),
    tags: [['e', image_event_id]],
    content
  };
  event.id = getEventHash(event);
  event.sig = signEvent(event, process.env.NOSTR_NSEC);
  const relay = relayInit('wss://relay.damus.io');
  await relay.connect();
  await relay.publish(event);
  relay.close();
}

async function getReplies(image_event_id, since) {
  const relay = relayInit('wss://relay.damus.io');
  await relay.connect();
  const sub = relay.sub([{ kinds: [1], '#e': [image_event_id], since }]);
  const replies = [];
  sub.on('event', event => replies.push(event));
  await new Promise(resolve => setTimeout(resolve, 5000));
  sub.unsub();
  relay.close();
  return replies;
}

async function postWinnerEvent(image_event_id, word, winner_pubkey) {
  const content = `The word was "${word}". Congratulations to nostr:${winner_pubkey} for guessing it!`;
  const event = {
    kind: 1,
    pubkey: getPublicKey(process.env.NOSTR_NSEC),
    created_at: Math.floor(Date.now() / 1000),
    tags: [['e', image_event_id]],
    content
  };
  event.id = getEventHash(event);
  event.sig = signEvent(event, process.env.NOSTR_NSEC);
  const relay = relayInit('wss://relay.damus.io');
  await relay.connect();
  await relay.publish(event);
  relay.close();
}

main().catch(console.error);
