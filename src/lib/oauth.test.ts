/**
 * unit test ของตรรกะล้วนในการเข้าสู่ระบบด้วย Google — ADR-058
 *
 * ส่วนที่คุยกับ Google/DB จริงอยู่ใน `npm run smoke:oauth`
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_RETURN_TO,
  OAUTH_USERNAME_BASE_MAX,
  decodeFlowCookie,
  encodeFlowCookie,
  frontendUrlFor,
  loginErrorUrl,
  pkceChallenge,
  readGoogleIdToken,
  safeReturnTo,
  usernameBaseFromEmail,
} from './oauth.js';

/** กฎเดียวกับ `username` ใน `schemas/auth.schema.ts` */
const USERNAME_RULE = /^[A-Za-z_][A-Za-z0-9_]{2,49}$/;

describe('safeReturnTo — กัน open redirect', () => {
  it('พาธปกติในเว็บผ่าน', () => {
    assert.equal(safeReturnTo('/practice'), '/practice');
    assert.equal(safeReturnTo('/users/12?tab=stats#top'), '/users/12?tab=stats#top');
    assert.equal(safeReturnTo('/'), '/');
  });

  it('ของที่พาออกนอกเว็บได้ถูกตีกลับเป็นหน้าแรก', () => {
    for (const bad of [
      '//evil.com',
      '/\\evil.com',
      'https://evil.com',
      'evil.com',
      '/ok\nSet-Cookie: x=1',
      '/space here',
      '',
      '/'.padEnd(201, 'a'),
    ]) {
      assert.equal(safeReturnTo(bad), DEFAULT_RETURN_TO, JSON.stringify(bad));
    }
  });

  it('ไม่ใช่สตริง (query ซ้ำชื่อ Express ให้มาเป็น array) → หน้าแรก', () => {
    assert.equal(safeReturnTo(['/a', '/b']), DEFAULT_RETURN_TO);
    assert.equal(safeReturnTo(undefined), DEFAULT_RETURN_TO);
  });
});

describe('frontendUrlFor / loginErrorUrl', () => {
  it('FRONTEND_URL มี / ต่อท้ายก็ไม่กลายเป็น //', () => {
    assert.equal(frontendUrlFor('http://localhost:5173/', '/practice'), 'http://localhost:5173/practice');
    assert.equal(loginErrorUrl('http://x.test', 'cancelled'), 'http://x.test/login?oauth_error=cancelled');
  });
});

describe('cookie ของ flow', () => {
  it('เข้ารหัสแล้วอ่านกลับได้ครบ', () => {
    const flow = { state: 's1', verifier: 'v1', returnTo: '/room/new' };
    assert.deepEqual(decodeFlowCookie(encodeFlowCookie(flow)), flow);
  });

  it('cookie ถูกแก้ returnTo เป็นโดเมนอื่น → กลับหน้าแรก', () => {
    const raw = encodeFlowCookie({ state: 's', verifier: 'v', returnTo: '//evil.com' });
    assert.equal(decodeFlowCookie(raw)?.returnTo, DEFAULT_RETURN_TO);
  });

  it('ขยะ / ขาดฟิลด์ → null', () => {
    assert.equal(decodeFlowCookie(undefined), null);
    assert.equal(decodeFlowCookie('not-base64-json'), null);
    assert.equal(decodeFlowCookie(Buffer.from('{"state":"s"}').toString('base64url')), null);
  });
});

describe('pkceChallenge', () => {
  it('ตรงกับตัวอย่างใน RFC 7636 ภาคผนวก B', () => {
    assert.equal(
      pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});

describe('readGoogleIdToken', () => {
  const CLIENT_ID = 'test-client.apps.googleusercontent.com';
  const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);

  function token(claims: Record<string, unknown>): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
  }

  const valid = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: NOW / 1000 + 3600,
    sub: '1234567890',
    email: 'Natakrit@Example.COM',
    email_verified: true,
    name: '  นที ทดสอบ ',
  };

  it('อ่าน claim ที่ถูกต้อง + ทำอีเมลเป็นตัวพิมพ์เล็ก + ตัดช่องว่างของชื่อ', () => {
    assert.deepEqual(readGoogleIdToken(token(valid), CLIENT_ID, NOW), {
      sub: '1234567890',
      email: 'natakrit@example.com',
      emailVerified: true,
      name: 'นที ทดสอบ',
    });
  });

  it('iss แบบไม่มี https:// ก็เป็นของ Google', () => {
    assert.equal(readGoogleIdToken(token({ ...valid, iss: 'accounts.google.com' }), CLIENT_ID, NOW).sub, '1234567890');
  });

  it('email_verified ไม่ใช่ true → emailVerified = false (ผู้เรียกไม่ผูกบัญชี)', () => {
    assert.equal(readGoogleIdToken(token({ ...valid, email_verified: false }), CLIENT_ID, NOW).emailVerified, false);
    assert.equal(readGoogleIdToken(token({ ...valid, email_verified: undefined }), CLIENT_ID, NOW).emailVerified, false);
    assert.equal(readGoogleIdToken(token({ ...valid, email_verified: 'true' }), CLIENT_ID, NOW).emailVerified, true);
  });

  it('ไม่มีชื่อ → null', () => {
    assert.equal(readGoogleIdToken(token({ ...valid, name: '   ' }), CLIENT_ID, NOW).name, null);
  });

  it('ปฏิเสธ token ที่ไม่ได้ออกโดย Google / ไม่ได้ออกให้เรา / หมดอายุ / ขาด sub หรืออีเมล', () => {
    const cases: Record<string, unknown>[] = [
      { ...valid, iss: 'https://evil.example' },
      { ...valid, aud: 'other-app' },
      { ...valid, exp: NOW / 1000 - 1 },
      { ...valid, exp: undefined },
      { ...valid, sub: '' },
      { ...valid, email: undefined },
    ];
    for (const claims of cases) {
      assert.throws(() => readGoogleIdToken(token(claims), CLIENT_ID, NOW), Error, JSON.stringify(claims));
    }
  });

  it('aud เป็น array ที่มีแอปเรา → ผ่าน', () => {
    assert.equal(readGoogleIdToken(token({ ...valid, aud: ['x', CLIENT_ID] }), CLIENT_ID, NOW).sub, '1234567890');
  });

  it('ไม่ใช่ JWT → throw', () => {
    assert.throws(() => readGoogleIdToken('abc', CLIENT_ID, NOW));
    assert.throws(() => readGoogleIdToken('a.!!!.c', CLIENT_ID, NOW));
  });
});

describe('usernameBaseFromEmail', () => {
  it('ใช้ส่วนหน้า @ ตรง ๆ เมื่อผ่านกฎอยู่แล้ว', () => {
    assert.equal(usernameBaseFromEmail('natakrit120@gmail.com'), 'natakrit120');
  });

  it('ตัวที่ใช้ไม่ได้เป็น _ และยุบ _ ที่ติดกัน', () => {
    assert.equal(usernameBaseFromEmail('first.last+tag@x.com'), 'first_last_tag');
    assert.equal(usernameBaseFromEmail('a..b--c@x.com'), 'a_b_c');
  });

  it('ขึ้นต้นด้วยตัวเลข / สั้นเกิน / ชื่อสงวน → เติม cuber_ นำหน้า', () => {
    assert.equal(usernameBaseFromEmail('120abc@x.com'), 'cuber_120abc');
    assert.equal(usernameBaseFromEmail('ab@x.com'), 'cuber_ab');
    assert.equal(usernameBaseFromEmail('deleted.user.5@x.com'), 'cuber_deleted_user_5');
  });

  it('ไม่เหลือตัวที่ใช้ได้เลย → cuber', () => {
    assert.equal(usernameBaseFromEmail('ภาษาไทย@x.com'), 'cuber');
    assert.equal(usernameBaseFromEmail('...@x.com'), 'cuber');
  });

  it('ยาวไม่เกินเพดานที่เผื่อต่อเลขสุ่ม', () => {
    const base = usernameBaseFromEmail(`${'a'.repeat(80)}@x.com`);
    assert.equal(base.length, OAUTH_USERNAME_BASE_MAX);
  });

  it('ผลลัพธ์ผ่านกฎ username ของ register ทุกเคส (รวมตอนต่อเลขสุ่มแล้ว)', () => {
    for (const email of [
      'natakrit120@gmail.com',
      '9@x.com',
      '_x_@x.com',
      'ภาษาไทย@x.com',
      `${'z'.repeat(80)}@x.com`,
      'deleted_user_1@x.com',
    ]) {
      const base = usernameBaseFromEmail(email);
      assert.match(base, USERNAME_RULE, email);
      assert.match(`${base}_12345678`, USERNAME_RULE, `${email} + เลขสุ่ม`);
      assert.doesNotMatch(base, /^deleted_user_/i, email);
    }
  });
});
