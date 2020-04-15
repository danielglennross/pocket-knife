import pem from 'pem';
import wrap from 'word-wrap';
import * as jwt from 'jsonwebtoken';
import * as R from 'ramda';
import { tuple } from '../async';

export type TokenValidateSuccessResult = { isOk: true };
export type TokenValidateErrorResult = { isOk: false; message: string };
export type TokenValidateResult =
  | TokenValidateSuccessResult
  | TokenValidateErrorResult;

export type TokenVerifyOptions = {
  requiredScope: string;
  validateToken?: (tokenPayload: TokenPayload) => Promise<TokenValidateResult>;
};

export type TokenPayload = {
  sub?: string;
  nbf?: number;
  scope: ReadonlyArray<string>;
  client_id?: string;
  sitecode?: string;
  auth_time?: string;
};

export type TokenSignOptions = {
  header: object;
  expiresIn: number;
};

export async function derToPublicKey(derCert: string) {
  const pemCert =
    '-----BEGIN CERTIFICATE-----\n' +
    `${wrap(derCert, { width: 64, cut: true, indent: '' })}\n` +
    '-----END CERTIFICATE-----';

  return new Promise((resolve, reject) =>
    pem.getPublicKey(pemCert, (err, pKey) => {
      if (err) {
        return reject(err);
      }
      return resolve(pKey.publicKey);
    }),
  );
}

export function signJwt(
  payload: TokenPayload,
  privateKey: string,
  jwtSignOptions: TokenSignOptions,
) {
  const { header, expiresIn } = jwtSignOptions;
  const options: jwt.SignOptions = {
    header,
    algorithm: 'RS256',
    expiresIn,
  };

  return jwt.sign(payload, privateKey, options);
}

export function decodeJwt(token: string) {
  return jwt.decode(token);
}

export async function verifyJwt(
  token: string,
  publicKey: string,
  options: TokenVerifyOptions,
): Promise<TokenPayload> {
  const jwtVerifyOptions = <jwt.VerifyOptions>{
    algorithms: ['RS256'],
    // nbf claim is validated manually to take clock skew into account
    ignoreNotBefore: true,
  };

  const [tokenPayload, err] = await tuple<TokenPayload, jwt.VerifyErrors>(
    new Promise((resolve, reject) => {
      return jwt.verify(
        token,
        publicKey,
        jwtVerifyOptions,
        async (err: jwt.VerifyErrors, tokenPayload: any) => {
          if (err) {
            return reject(err);
          }
          return resolve(tokenPayload);
        },
      );
    }),
  );

  if (err) {
    throw new Error(err.message);
  }

  if (options.requiredScope) {
    if (!R.includes(options.requiredScope, tokenPayload.scope)) {
      throw new Error('invalid scopes');
    }
  }

  if (tokenPayload.nbf) {
    const now = Math.floor(Date.now() / 1000);
    if (tokenPayload.nbf - 3000 > now) {
      throw new Error('token not active yet');
    }
  }

  if (options.validateToken) {
    const validateResult = await options.validateToken(tokenPayload);
    if (!validateResult.isOk) {
      throw new Error((<TokenValidateErrorResult>validateResult).message);
    }
  }

  return tokenPayload;
}
