import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCardInputs,formatPaymentCard} from '../src/payment-card-input.js';
import {parsePaymentCards,publicPreview} from '../src/zzshu-cards.js';

const pan='4242424242424242',now=new Date('2026-10-13T00:00:00Z');
test('all supported input styles produce the exact ZZS one-paste format and preserve leading CVV zeros',()=>{
  for(const input of [
    pan+',10/30,096',
    pan+' 096 2030-10',
    '卡号:'+pan+';CVV096;有效期:10/30',
    pan+'----10/30----096----',
    pan+' ---- 10/30 ---- 096'
  ]){
    const row=parseCardInputs(input,now)[0];
    assert.equal(row.status,'ready');
    assert.equal(formatPaymentCard(row.payment),pan+'----10/30----096----');
    const server=parsePaymentCards(input,new Set(),now)[0];
    assert.deepEqual(server.payment,row.payment);
    assert.equal(JSON.stringify(publicPreview([server])).includes(pan),false);
    assert.equal(JSON.stringify(publicPreview([server])).includes('096'),false);
  }
});

test('malformed separators, missing fields, invalid dates and extra fields never become copyable results',()=>{
  for(const input of [
    pan+'----10/30----',
    pan+'----13/30----321----',
    pan+'----10/20----321----',
    pan+'----10/30----32----',
    pan+'----10/30----321----unexpected',
    pan+'----10/30----321--------'
  ])assert.equal(parseCardInputs(input,now)[0].status,'error');
});

test('batch duplicates and empty lines retain line positions; existing database duplicates still use fingerprints',()=>{
  const input=pan+',10/30,096\n\n'+pan+'----10/30----096----\n4000000000000002----10/30----321----';
  const rows=parseCardInputs(input,now);
  assert.deepEqual(rows.map(row=>row.status),['ready','empty','duplicate','ready']);
  assert.equal(rows[3].line,4);
  const server=parsePaymentCards(input,new Set(),now);
  assert.deepEqual(server.map(row=>row.status),rows.map(row=>row.status));
  assert.equal(parsePaymentCards(pan+'----10/30----096----',new Set([server[0].fingerprint]),now)[0].status,'duplicate');
});
