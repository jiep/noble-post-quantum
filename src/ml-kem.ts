/*! noble-post-quantum - MIT License (c) 2024 Paul Miller (paulmillr.com) */
import { ctr } from '@noble/ciphers/aes';
import { sha256, sha512 } from '@noble/hashes/sha2';
import { sha3_256, sha3_512, shake256 } from '@noble/hashes/sha3';
import { u32, wrapConstructor, wrapConstructorWithOpts } from '@noble/hashes/utils';
import { genCrystals, XOF, XOF_AES, XOF128 } from './_crystals.js';
import {
  Coder,
  cleanBytes,
  ensureBytes,
  equalBytes,
  randomBytes,
  splitCoder,
  vecCoder,
} from './utils.js';

/*
Lattice-based key encapsulation mechanism.
See [official site](https://www.pq-crystals.org/kyber/resources.shtml),
[repo](https://github.com/pq-crystals/kyber),
[spec](https://datatracker.ietf.org/doc/draft-cfrg-schwabe-kyber/).

Key encapsulation is similar to DH / ECDH (think X25519), with important differences:

- We can't verify if it was "Bob" who've sent the shared secret.
  In ECDH, it's always verified
- Kyber is probabalistic and relies on quality of randomness (CSPRNG).
  ECDH doesn't (to this extent).
- Kyber decapsulation never throws an error, even when shared secret was
  encrypted by a different public key. It will just return a different
  shared secret

There are some concerns with regards to security: see
[djb blog](https://blog.cr.yp.to/20231003-countcorrectly.html) and
[mailing list](https://groups.google.com/a/list.nist.gov/g/pqc-forum/c/W2VOzy0wz_E).

Three versions are provided:

1. Kyber
2. Kyber-90s, using algorithms from 1990s
3. ML-KEM aka [FIPS-203](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.203.ipd.pdf)
*/

const N = 256; // Kyber (not FIPS-203) supports different lengths, but all std modes were using 256
const Q = 3329; // 13*(2**8)+1, modulo prime
const F = 3303; // 3303 ≡ 128**(−1) mod q (FIPS-203)
const ROOT_OF_UNITY = 17; // ζ = 17 ∈ Zq is a primitive 256-th root of unity modulo Q. ζ**128 ≡−1
const { mod, nttZetas, NTT, bitsCoder } = genCrystals({
  N,
  Q,
  F,
  ROOT_OF_UNITY,
  newPoly: (n: number) => new Uint16Array(n),
  brvBits: 7,
  isKyber: true,
});

// FIPS 203: 7. Parameter Sets
type ParameterSet = {
  N: number;
  K: number;
  Q: number;
  ETA1: number;
  ETA2: number;
  du: number;
  dv: number;
  RBGstrength: number;
};
// prettier-ignore
export const PARAMS: Record<string, ParameterSet> = {
  512: { N, Q, K: 2, ETA1: 3, ETA2: 2, du: 10, dv: 4, RBGstrength: 128 },
  768: { N, Q, K: 3, ETA1: 2, ETA2: 2, du: 10, dv: 4, RBGstrength: 192 },
  1024:{ N, Q, K: 4, ETA1: 2, ETA2: 2, du: 11, dv: 5, RBGstrength: 256 },
} as const;

// FIPS-203: compress/decompress
const compress = (d: number): Coder<number, number> => {
  // Special case, no need to compress, pass as is, but strip high bytes on compression
  if (d >= 12) return { encode: (i: number) => i, decode: (i: number) => i };
  // NOTE: we don't use float arithmetic (forbidden by FIPS-203 and high chance of bugs).
  // Comments map to python implementation in RFC (draft-cfrg-schwabe-kyber)
  // const round = (i: number) => Math.floor(i + 0.5) | 0;
  const a = 2 ** (d - 1);
  return {
    // const compress = (i: number) => round((2 ** d / Q) * i) % 2 ** d;
    encode: (i: number) => ((i << d) + Q / 2) / Q,
    // const decompress = (i: number) => round((Q / 2 ** d) * i);
    decode: (i: number) => (i * Q + a) >>> d,
  };
};

// NOTE: we merge encoding and compress because it is faster, also both require same d param
// Converts between bytes and d-bits compressed representation. Kinda like convertRadix2 from @scure/base
// decode(encode(t)) == t, but there is loss of information on encode(decode(t))
const polyCoder = (d: number) => bitsCoder(d, compress(d));

// Poly is mod Q, so 12 bits
type Poly = Uint16Array;

function polyAdd(a: Poly, b: Poly) {
  for (let i = 0; i < N; i++) a[i] = mod(a[i] + b[i]); // a += b
}
function polySub(a: Poly, b: Poly) {
  for (let i = 0; i < N; i++) a[i] = mod(a[i] - b[i]); // a -= b
}

// FIPS-203: Computes the product of two degree-one polynomials with respect to a quadratic modulus
function BaseCaseMultiply(a0: number, a1: number, b0: number, b1: number, zeta: number) {
  const c0 = mod(a1 * b1 * zeta + a0 * b0);
  const c1 = mod(a0 * b1 + a1 * b0);
  return { c0, c1 };
}

// FIPS-203: Computes the product (in the ring Tq) of two NTT representations. NOTE: works inplace for f
// NOTE: since multiply defined only for NTT representation, we need to convert to NTT, multiply and convert back
function MultiplyNTTs(f: Poly, g: Poly): Poly {
  for (let i = 0; i < N / 2; i++) {
    let z = nttZetas[64 + (i >> 1)];
    if (i & 1) z = -z;
    const { c0, c1 } = BaseCaseMultiply(f[2 * i + 0], f[2 * i + 1], g[2 * i + 0], g[2 * i + 1], z);
    f[2 * i + 0] = c0;
    f[2 * i + 1] = c1;
  }
  return f;
}

type PRF = (l: number, key: Uint8Array, nonce: number) => Uint8Array;

type Hash = ReturnType<typeof wrapConstructor>;
type HashWOpts = ReturnType<typeof wrapConstructorWithOpts>;
type XofGet = ReturnType<ReturnType<XOF>['get']>;

type KyberOpts = ParameterSet & {
  HASH256: Hash;
  HASH512: Hash;
  KDF: Hash | HashWOpts;
  XOF: XOF; // (seed: Uint8Array, len: number, x: number, y: number) => Uint8Array;
  PRF: PRF;
  FIPS203?: boolean;
};

// Return poly in NTT representation
function SampleNTT(xof: XofGet) {
  const r: Poly = new Uint16Array(N);
  for (let j = 0; j < N; ) {
    const b = xof();
    if (b.length % 3) throw new Error('SampleNTT: unaligned block');
    for (let i = 0; j < N && i + 3 <= b.length; i += 3) {
      const d1 = ((b[i + 0] >> 0) | (b[i + 1] << 8)) & 0xfff;
      const d2 = ((b[i + 1] >> 4) | (b[i + 2] << 4)) & 0xfff;
      if (d1 < Q) r[j++] = d1;
      if (j < N && d2 < Q) r[j++] = d2;
    }
  }
  return r;
}

// Sampling from the centered binomial distribution
// Returns poly with small coefficients (noise/errors)
function sampleCBD(PRF: PRF, seed: Uint8Array, nonce: number, eta: number): Poly {
  const buf = PRF((eta * N) / 4, seed, nonce);
  const r: Poly = new Uint16Array(N);
  const b32 = u32(buf);
  let len = 0;
  for (let i = 0, p = 0, bb = 0, t0 = 0; i < b32.length; i++) {
    let b = b32[i];
    for (let j = 0; j < 32; j++) {
      bb += b & 1;
      b >>= 1;
      len += 1;
      if (len === eta) {
        t0 = bb;
        bb = 0;
      } else if (len === 2 * eta) {
        r[p++] = mod(t0 - bb);
        bb = 0;
        len = 0;
      }
    }
  }
  if (len) throw new Error(`sampleCBD: leftover bits: ${len}`);
  return r;
}

// K-PKE
// As per FIPS-203, it doesn't perform any input validation and can't be used in standalone fashion.
const genKPKE = (opts: KyberOpts) => {
  const { K, PRF, XOF, HASH512, ETA1, ETA2, du, dv, FIPS203 } = opts;
  const poly1 = polyCoder(1);
  const polyV = polyCoder(dv);
  const polyU = polyCoder(du);
  const publicCoder = splitCoder(vecCoder(polyCoder(12), K), 32);
  const secretCoder = vecCoder(polyCoder(12), K);
  const cipherCoder = splitCoder(vecCoder(polyU, K), polyV);
  const seedCoder = splitCoder(32, 32);
  return {
    secretCoder,
    secretKeyLen: secretCoder.bytesLen,
    publicKeyLen: publicCoder.bytesLen,
    cipherTextLen: cipherCoder.bytesLen,
    keygen: (seed: Uint8Array) => {
      const [rho, sigma] = seedCoder.decode(HASH512(seed));
      const sHat: Poly[] = [];
      const tHat: Poly[] = [];
      for (let i = 0; i < K; i++) sHat.push(NTT.encode(sampleCBD(PRF, sigma, i, ETA1)));
      const x = XOF(rho);
      for (let i = 0; i < K; i++) {
        const e = NTT.encode(sampleCBD(PRF, sigma, K + i, ETA1));
        for (let j = 0; j < K; j++) {
          const aji = SampleNTT(FIPS203 ? x.get(i, j) : x.get(j, i)); // A[j][i], inplace
          polyAdd(e, MultiplyNTTs(aji, sHat[j]));
        }
        tHat.push(e); // t ← A ◦ s + e
      }
      x.clean();
      const res = {
        publicKey: publicCoder.encode([tHat, rho]),
        secretKey: secretCoder.encode(sHat),
      };
      cleanBytes(rho, sigma, sHat, tHat);
      return res;
    },
    encrypt: (publicKey: Uint8Array, msg: Uint8Array, seed: Uint8Array) => {
      const [tHat, rho] = publicCoder.decode(publicKey);
      const rHat = [];
      for (let i = 0; i < K; i++) rHat.push(NTT.encode(sampleCBD(PRF, seed, i, ETA1)));
      const x = XOF(rho);
      const tmp2 = new Uint16Array(N);
      const u = [];
      for (let i = 0; i < K; i++) {
        const e1 = sampleCBD(PRF, seed, K + i, ETA2);
        const tmp = new Uint16Array(N);
        for (let j = 0; j < K; j++) {
          const aij = SampleNTT(FIPS203 ? x.get(j, i) : x.get(i, j)); // A[i][j], inplace
          polyAdd(tmp, MultiplyNTTs(aij, rHat[j])); // t += aij * rHat[j]
        }
        polyAdd(e1, NTT.decode(tmp)); // e1 += tmp
        u.push(e1);
        polyAdd(tmp2, MultiplyNTTs(tHat[i], rHat[i])); // t2 += tHat[i] * rHat[i]
        tmp.fill(0);
      }
      x.clean();
      const e2 = sampleCBD(PRF, seed, 2 * K, ETA2);
      polyAdd(e2, NTT.decode(tmp2)); // e2 += tmp2
      const v = poly1.decode(msg); // encode plaintext m into polynomial v
      polyAdd(v, e2); // v += e2
      cleanBytes(tHat, rHat, tmp2, e2);
      return cipherCoder.encode([u, v]);
    },
    decrypt: (cipherText: Uint8Array, privateKey: Uint8Array) => {
      const [u, v] = cipherCoder.decode(cipherText);
      const sk = secretCoder.decode(privateKey); // s  ← ByteDecode_12(dkPKE)
      const tmp = new Uint16Array(N);
      for (let i = 0; i < K; i++) polyAdd(tmp, MultiplyNTTs(sk[i], NTT.encode(u[i]))); // tmp += sk[i] * u[i]
      polySub(v, NTT.decode(tmp)); // v += tmp
      cleanBytes(tmp, sk, u);
      return poly1.encode(v);
    },
  };
};

function createKyber(opts: KyberOpts) {
  const KPKE = genKPKE(opts);
  const { HASH256, HASH512, KDF, FIPS203 } = opts;
  const { secretCoder: KPKESecretCoder, cipherTextLen } = KPKE;
  const publicKeyLen = KPKE.publicKeyLen; // 384*K+32
  const secretCoder = splitCoder(KPKE.secretKeyLen, KPKE.publicKeyLen, 32, 32);
  const secretKeyLen = secretCoder.bytesLen;
  const msgLen = 32;
  return {
    publicKeyLen,
    msgLen,
    keygen: (seed = randomBytes(64)) => {
      ensureBytes(seed, 64);
      const { publicKey, secretKey: sk } = KPKE.keygen(seed.subarray(0, 32));
      const publicKeyHash = HASH256(publicKey);
      // (dkPKE||ek||H(ek)||z)
      const secretKey = secretCoder.encode([sk, publicKey, publicKeyHash, seed.subarray(32)]);
      cleanBytes(sk, publicKeyHash);
      return { publicKey, secretKey };
    },
    encapsulate: (publicKey: Uint8Array, msg = randomBytes(32)) => {
      ensureBytes(publicKey, publicKeyLen);
      ensureBytes(msg, msgLen);
      if (!FIPS203) msg = HASH256(msg); // NOTE: ML-KEM doesn't have this step!
      else {
        // FIPS-203 includes additional verification check for modulus
        const eke = publicKey.subarray(0, 384 * opts.K);
        const ek = KPKESecretCoder.encode(KPKESecretCoder.decode(eke.slice())); // Copy because of inplace encoding
        // (Modulus check.) Perform the computation ek ← ByteEncode12(ByteDecode12(eke)).
        // If ek = ̸ eke, the input is invalid. (See Section 4.2.1.)
        if (!equalBytes(ek, eke)) {
          cleanBytes(ek);
          throw new Error('ML-KEM.encapsulate: wrong publicKey modulus');
        }
        cleanBytes(ek);
      }
      const kr = HASH512.create().update(msg).update(HASH256(publicKey)).digest(); // derive randomness
      const cipherText = KPKE.encrypt(publicKey, msg, kr.subarray(32, 64));
      if (FIPS203) return { cipherText, sharedSecret: kr.subarray(0, 32) };
      const cipherTextHash = HASH256(cipherText);
      const sharedSecret = KDF.create({})
        .update(kr.subarray(0, 32))
        .update(cipherTextHash)
        .digest();
      cleanBytes(kr, cipherTextHash);
      return { cipherText, sharedSecret };
    },
    decapsulate: (cipherText: Uint8Array, secretKey: Uint8Array) => {
      ensureBytes(secretKey, secretKeyLen); // 768*k + 96
      ensureBytes(cipherText, cipherTextLen); // 32(du*k + dv)
      const [sk, publicKey, publicKeyHash, z] = secretCoder.decode(secretKey);
      const msg = KPKE.decrypt(cipherText, sk);
      const kr = HASH512.create().update(msg).update(publicKeyHash).digest(); // derive randomness, Khat, rHat = G(mHat || h)
      const Khat = kr.subarray(0, 32);
      const cipherText2 = KPKE.encrypt(publicKey, msg, kr.subarray(32, 64)); // re-encrypt using the derived randomness
      const isValid = equalBytes(cipherText, cipherText2); // if ciphertexts do not match, “implicitly reject”
      if (FIPS203) {
        const Kbar = KDF.create({ dkLen: 32 }).update(z).update(cipherText).digest();
        cleanBytes(msg, cipherText2, !isValid ? Khat : Kbar);
        return isValid ? Khat : Kbar;
      }
      const cipherTextHash = HASH256(cipherText);
      const sharedSecret = KDF.create({ dkLen: 32 })
        .update(isValid ? Khat : z)
        .update(cipherTextHash)
        .digest();
      cleanBytes(msg, cipherTextHash, cipherText2, Khat, z);
      return sharedSecret;
    },
  };
}

function PRF(l: number, key: Uint8Array, nonce: number) {
  const _nonce = new Uint8Array(16);
  _nonce[0] = nonce;
  return ctr(key, _nonce).encrypt(new Uint8Array(l));
}

const opts90s = { HASH256: sha256, HASH512: sha512, KDF: sha256, XOF: XOF_AES, PRF };

export const kyber512_90s = /* @__PURE__ */ createKyber({
  ...opts90s,
  ...PARAMS[512],
});
export const kyber768_90s = /* @__PURE__ */ createKyber({
  ...opts90s,
  ...PARAMS[768],
});
export const kyber1024_90s = /* @__PURE__ */ createKyber({
  ...opts90s,
  ...PARAMS[1024],
});

function shakePRF(dkLen: number, key: Uint8Array, nonce: number) {
  return shake256
    .create({ dkLen })
    .update(key)
    .update(new Uint8Array([nonce]))
    .digest();
}

const opts = {
  HASH256: sha3_256,
  HASH512: sha3_512,
  KDF: shake256,
  XOF: XOF128,
  PRF: shakePRF,
};

export const kyber512 = /* @__PURE__ */ createKyber({
  ...opts,
  ...PARAMS[512],
});
export const kyber768 = /* @__PURE__ */ createKyber({
  ...opts,
  ...PARAMS[768],
});
export const kyber1024 = /* @__PURE__ */ createKyber({
  ...opts,
  ...PARAMS[1024],
});

/**
 * FIPS-203 (draft) ML-KEM.
 * Unsafe: we can't cross-verify, because there are no test vectors or other implementations.
 */

export const ml_kem512 = /* @__PURE__ */ createKyber({
  ...opts,
  ...PARAMS[512],
  FIPS203: true,
});
export const ml_kem768 = /* @__PURE__ */ createKyber({
  ...opts,
  ...PARAMS[768],
  FIPS203: true,
});
export const ml_kem1024 = /* @__PURE__ */ createKyber({
  ...opts,
  ...PARAMS[1024],
  FIPS203: true,
});
