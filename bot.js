const fs = require('fs');
const { relayInit, getPublicKey, getEventHash, signEvent } = require('nostr-tools');
const axios = require('axios');

async function main() {
  console.log('Bot started at', new Date().toISOString());
  const state = JSON.parse(fs.readFileSync('words.json', 'utf8'));
  const current_block = await getCurrentBlockHeight();
  console.log(`Current block: ${current_block}, Next word block: ${state.next_word_block}`);

  const relays = [
    relayInit('wss://relay.nostrfreaks.com'),
    relayInit('wss://relay.damus.io')
  ];
  await Promise.all(relays.map(r => r.connect().catch(err => console.error(`Relay connect failed: ${err}`))));

  if (current_block >= state.next_word_block) {
    console.log('Posting new word image');
    const word = await getRandomWord();
    const image_url = await generateImage(word);
    const event_id = await postImageEvent(image_url, relays);
    state.words.push({
      word,
      image_url,
      image_event_id: event_id,
      posted_at_block: current_block,
      next_hint_block: current_block + 21,
      hints_posted: 0,
      winner: null
    });
    state.next_word_block = current_block + 144;
    console.log(`New word posted: ${word}, Next drop at block ${state.next_word_block}`);
  }

  for (const word of state.words) {
    if (word.winner === null) {
      if (current_block >= word.next_hint_block) {
        console.log(`Posting hint for ${word.word}`);
        const hint = await getHint(word.word);
        await postHintEvent(word.image_event_id, hint, relays);
        word.hints_posted += 1;
        word.next_hint_block += 21;
      }
      const replies = await getReplies(word.image_event_id, state.last_checked_time, relays[1]); // damus relay
      for (const reply of replies) {
        if (reply.kind === 1 && reply.content.toLowerCase().includes(word.word.toLowerCase())) {
          console.log(`Winner found for ${word.word}: ${reply.pubkey}`);
          word.winner = reply.pubkey;
          await postWinnerEvent(word.image_event_id, word.word, reply.pubkey, relays);
          state.leaderboard[reply.pubkey] = (state.leaderboard[reply.pubkey] || 0) + 1;
          await postLeaderboardEvent(state.leaderboard, relays);
          break;
        }
      }
    }
  }

  state.last_checked_time = Math.floor(Date.now() / 1000);
  fs.writeFileSync('words.json', JSON.stringify(state, null, 2));
  console.log('State updated and saved');
  relays.forEach(r => r.close());
}

async function getCurrentBlockHeight() {
  try {
    const response = await axios.get('https://blockchain.info/q/getblockcount');
    return parseInt(response.data);
  } catch (error) {
    console.error('Error fetching block height:', error);
    throw error;
  }
}

async function getRandomWord() {
  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Give me a random word.' }]
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } });
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error fetching random word:', error);
    throw error;
  }
}

async function generateImage(word) {
  try {
    const response = await axios.post('https://api.openai.com/v1/images/generations', {
      prompt: `An image of ${word}`,
      n: 1,
      size: '512x512'
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } });
    return response.data.data[0].url; // Use OpenAI's temporary URL directly
  } catch (error) {
    console.error('Error generating image:', error);
    throw error;
  }
}

async function postImageEvent(image_url, relays) {
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
  await Promise.all(relays.map(r => r.publish(event).catch(err => console.error(`Publish failed: ${err}`))));
  return event.id;
}

async function getHint(word) {
  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4',
      messages: [{ role: 'user', content: `Give me a hint for the word "${word}" without saying the word.` }]
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } });
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error fetching hint:', error);
    throw error;
  }
}

async function postHintEvent(image_event_id, hint, relays) {
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
  await Promise.all(relays.map(r => r.publish(event).catch(err => console.error(`Publish failed: ${err}`))));
}

async function getReplies(image_event_id, since, relay) {
  await relay.connect();
  const sub = relay.sub([{ kinds: [1], '#e': [image_event_id], since }]);
  const replies = [];
  sub.on('event', event => replies.push(event));
  await new Promise(resolve => setTimeout(resolve, 5000));
  sub.unsub();
  return replies;
}

async function postWinnerEvent(image_event_id, word, winner_pubkey, relays) {
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
  await Promise.all(relays.map(r => r.publish(event).catch(err => console.error(`Publish failed: ${err}`))));
}

async function postLeaderboardEvent(leaderboard, relays) {
  const content = JSON.stringify(leaderboard);
  const event = {
    kind: 82632001,
    pubkey: getPublicKey(process.env.NOSTR_NSEC),
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content
  };
  event.id = getEventHash(event);
  event.sig = signEvent(event, process.env.NOSTR_NSEC);
  await Promise.all(relays.map(r => r.publish(event).catch(err => console.error(`Publish failed: ${err}`))));
}

main().catch(err => console.error('Main error:', err));
