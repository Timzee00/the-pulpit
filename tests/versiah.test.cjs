const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { handler } = require('../netlify/functions/versiah.js');
const originalFetch = global.fetch;
const originalKey = process.env.GROQ_API_KEY;
afterEach(() => { global.fetch = originalFetch; if (originalKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = originalKey; });
const event = (body, method = 'POST') => ({ httpMethod: method, body: JSON.stringify(body) });
const decode = result => { assert.equal(typeof result.statusCode, 'number'); assert.equal(typeof result.body, 'string'); return JSON.parse(result.body); };
const model = data => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }));
test('rejects invalid methods, JSON, types and oversized input using Netlify response contract', async () => {
  assert.equal((await handler(event({}, 'GET'))).statusCode, 405);
  assert.equal((await handler({ httpMethod: 'POST', body: '{' })).statusCode, 400);
  for (const value of [null, [], {}, {message: 42}, {message: 'x'.repeat(2601)}]) assert.equal((await handler(event(value))).statusCode, 400);
  assert.equal((await handler(event({message:'x'.repeat(25000)}))).statusCode, 413);
});
test('urgent support works without upstream services or credentials', async () => {
  global.fetch = () => { throw new Error('must not request upstream'); };
  const r = await handler(event({message:'I want to kill myself'}));
  assert.equal(r.statusCode, 200); const data = decode(r);
  assert.equal(data.safety, true); assert.match(data.answer, /emergency/); assert.deepEqual(data.scriptures, []);
});
test('reads standard server environment and answers using verified passages', async () => {
  process.env.GROQ_API_KEY = 'test-key'; let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    if (url.startsWith('https://bible-api.com/')) return new Response(JSON.stringify({ reference:'John 3:16', verses:[{verse:16,text:'Verified verse text.'}] }));
    assert.equal(options.headers.authorization, 'Bearer test-key');
    const prompt = JSON.parse(options.body).messages[1].content;
    if (calls === 1) return model({references:[{reference:'John 3:16'}]});
    assert.match(prompt, /Verified verse text/);
    return model({answer:'A grounded answer.',reflection:'Reflect.',prayer:'A prayer.',note:''});
  };
  const r = await handler(event({message:'Explain the gospel'}));
  assert.equal(r.statusCode, 200); const data = decode(r);
  assert.equal(data.scriptures[0].verses[0].text,'Verified verse text.'); assert.equal(calls,3);
});
test('explicit empty reference list does not fabricate unrelated scriptural support', async () => {
  process.env.GROQ_API_KEY = 'test-key'; let calls = 0;
  global.fetch = async url => { assert.ok(!url.startsWith('https://bible-api.com/')); return ++calls === 1 ? model({references:[]}) : model({answer:'Scripture does not directly answer this question.'}); };
  const r = await handler(event({message:'Which phone should I buy?'}));
  assert.equal(r.statusCode,200); assert.deepEqual(decode(r).scriptures,[]); assert.equal(calls,2);
});
test('unverified references fail clearly rather than appear as Scripture', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  global.fetch = async url => url.startsWith('https://bible-api.com/') ? new Response('{}',{status:503}) : model({references:[{reference:'John 3:16'}]});
  const r = await handler(event({message:'Explain John 3:16'}));
  assert.equal(r.statusCode,502); assert.match(decode(r).error,/verify/);
});
