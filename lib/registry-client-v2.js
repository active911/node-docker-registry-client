/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Docker Registry API v2 client. See the README for an intro.
 *
 * <https://docs.docker.com/registry/spec/api/>
 */

var assert = require('assert-plus');
var base64url = require('base64url');
var bunyan = require('bunyan');
var crypto = require('crypto');
var fmt = require('util').format;
var jwkToPem = require('jwk-to-pem');
var mod_jws = require('jws');
var querystring = require('querystring');
var restify = require('restify');
var strsplit = require('strsplit');
var mod_url = require('url');
var vasync = require('vasync');
var VError = require('verror').VError;

var common = require('./common');
var DockerJsonClient = require('./docker-json-client');
var errors = require('./errors');


// --- Globals

var DEFAULT_REGISTRY_URL_V2 = 'https://registry-1.docker.io/v2/';



// --- internal support functions

/**
 * XXX still true for v2?
 *
 * Special handling of errors from the registry server.
 *
 * When some of the endpoints get a 404, the response body is a largish dump
 * of test/html. We don't want to include that as an error "message". It
 * isn't useful.
 *
 * Usage:
 *      cb(new _sanitizeErr(err, req, res[, errmsg]));
 *
 * where `errmsg` is an optional fallback error message to use for the
 * sanitized 404 err.message.
 */
function _sanitizeErr(err, req, res, errmsg) {
    if (err.statusCode === 404 && res && res.headers['content-type'] &&
        res.headers['content-type'].split(';')[0] !== 'application/json')
    {
        err.message = errmsg || 'not found';
    }
    return err;
}

/**
 * Parse a WWW-Authenticate header like this:
 *
 *      // JSSTYLED
 *      www-authenticate: Bearer realm="https://auth.docker.io/token",service="registry.docker.io"
 *
 * into an object like this:
 *
 *      {
 *          scheme: 'Bearer',
 *          parms: {
 *              realm: 'https://auth.docker.io/token',
 *              service: 'registry.docker.io'
 *          }
 *      }
 *
 * Note: This doesn't handle *multiple* challenges. I've not seen a concrete
 * example of that.
 */
function _parseAuthChallenge(res) {
    var parsers = require('www-authenticate/lib/parsers');
    var header = res.headers['www-authenticate'];
    var parsed = new parsers.WWW_Authenticate(header);
    if (parsed.err) {
        throw new Error('could not parse WWW-Authenticate header "' + header
            + '": ' + parsed.err);
    }
    return parsed;
}


/**
 * Get an auth token.
 *
 * See: docker/docker.git:registry/token.go
 */
function _getToken(opts, cb) {
    assert.object(opts.log, 'opts.log');
    assert.string(opts.indexName, 'opts.indexName'); // used for error messages
    assert.string(opts.realm, 'opts.realm');
    assert.optionalString(opts.service, 'opts.service');
    assert.optionalArrayOfString(opts.scopes, 'opts.scopes');
    assert.optionalString(opts.username, 'opts.username');
    assert.optionalString(opts.password, 'opts.password');
    assert.bool(opts.insecure, 'opts.insecure');
    var log = opts.log;

    // - add https:// prefix (or http) if none on 'realm'
    var tokenUrl = opts.realm;
    var match = /^(\w+):\/\//.exec(tokenUrl);
    if (!match) {
        tokenUrl = (opts.insecure ? 'http' : 'https') + '://' + tokenUrl;
    } else if (['http', 'https'].indexOf(match[1]) === -1) {
        return cb(new Error(fmt('unsupported scheme for ' +
            'WWW-Authenticate realm "%s": "%s"', opts.realm, match[1])));
    }

    // - GET $realm
    //      ?service=$service
    //      (&scope=$scope)*
    //      (&account=$username)
    //   Authorization: Basic ...
    var headers = {};
    var query = {};
    if (opts.service) {
        query.service = opts.service;
    }
    if (opts.scopes && opts.scopes.length) {
        query.scope = opts.scopes;  // intentionally singular 'scope'
    }
    if (opts.username) {
        assert.string(opts.password, 'password required if "username" given');
        query.account = opts.username;
        var buffer = new Buffer(opts.username + ':' + opts.password, 'utf8');
        headers.authorization = 'Basic ' + buffer.toString('base64');
    }
    if (Object.keys(query).length) {
        tokenUrl += '?' + querystring.stringify(query);
    }
    log.trace({tokenUrl: tokenUrl}, '_getToken: url');

    var parsedUrl = mod_url.parse(tokenUrl);
    var client = new DockerJsonClient({
        url: parsedUrl.protocol + '//' + parsedUrl.host,
        log: log,
        agent: false,
        rejectUnauthorized: !opts.insecure
    });
    client.get({
        path: parsedUrl.path,
        headers: headers
    }, function (err, req, res, body) {
        if (err) {
            return cb(new VError(err, fmt(
                'token auth attempt for %s: %s request failed with status %s',
                opts.indexName, tokenUrl, (res ? res.statusCode : '???'))));
        } else if (!body.token) {
            return cb(new VError(err, 'authorization server did not ' +
                'include a token in the response'));
        }
        cb(null, body.token);
    });
}

/**
 * Convenience wrapper on RegistryClientV2._login for use in `vasync.pipeline`.
 */
function login(regClient, cb) {
    regClient._login(cb);
}


/* BEGIN JSSTYLED */
/*
 * Parse out a JWS (JSON Web Signature) from the given Docker manifest
 * endpoint response. This JWS is used for both 'Docker-Content-Digest' header
 * verification and JWS signing verification.
 *
 * This mimicks:
 *      func ParsePrettySignature(content []byte, signatureKey string)
 *          (*JSONSignature, error)
 * in "docker/vendor/src/github.com/docker/libtrust/jsonsign.go"
 *
 * @returns {Object} JWS object with 'payload' and 'signatures' fields.
 * @throws {InvalidContentError} if there is a problem parsing the manifest
 *      body.
 *
 *
 * # Design
 *
 * tl;dr: Per <https://docs.docker.com/registry/spec/api/#digest-header>
 * the payload used for the digest is a little obtuse for the getManifest
 * endpoint: It is the raw JSON body (the raw content because indentation
 * and key order matters) minus the "signatures" key. The "signatures"
 * key is always the last one. The byte offset at which to strip and a
 * suffix to append is included in the JWS "protected" header.
 *
 *
 * A longer explanation:
 *
 * Let's use the following (clipped for clarity) sample getManifest
 * request/response to a Docker v2 Registry API (in this case Docker Hub):
 *
 *     GET /v2/library/alpine/manifests/latest HTTP/1.1
 *     ...
 *
 *     HTTP/1.1 200 OK
 *     docker-content-digest: sha256:08a98db12e...fe0d
 *     ...
 *
 *     {
 *         "schemaVersion": 1,
 *         "name": "library/alpine",
 *         "tag": "latest",
 *         "architecture": "amd64",
 *         "fsLayers": [
 *             {
 *                 "blobSum": "sha256:c862d82a67...d58"
 *             }
 *         ],
 *         "history": [
 *             {
 *                 "v1Compatibility": "{\"id\":\"31f6...4492}\n"
 *             }
 *         ],
 *         "signatures": [
 *             {
 *                 "header": {
 *                     "jwk": {
 *                         "crv": "P-256",
 *                         "kid": "OIH7:HQFS:44FK:45VB:3B53:OIAG:TPL4:ATF5:6PNE:MGHN:NHQX:2GE4",
 *                         "kty": "EC",
 *                         "x": "Cu_UyxwLgHzE9rvlYSmvVdqYCXY42E9eNhBb0xNv0SQ",
 *                         "y": "zUsjWJkeKQ5tv7S-hl1Tg71cd-CqnrtiiLxSi6N_yc8"
 *                     },
 *                     "alg": "ES256"
 *                 },
 *                 "signature": "JV1F_gXAsUEp_e2WswSdHjvI0veC-f6EEYuYJZhgIPpN-LQ5-IBSOX7Ayq1gv1m2cjqPy3iXYc2HeYgCQTxM-Q",
 *                 "protected": "eyJmb3JtYXRMZW5ndGgiOjE2NzUsImZvcm1hdFRhaWwiOiJDbjAiLCJ0aW1lIjoiMjAxNS0wOS0xMFQyMzoyODowNloifQ"
 *             }
 *         ]
 *     }
 *
 *
 * We will be talking about specs from the IETF JavaScript Object Signing
 * and Encryption (JOSE) working group
 * <https://datatracker.ietf.org/wg/jose/documents/>. The relevant ones
 * with Docker registry v2 (a.k.a. docker/distribution) are:
 *
 * 1. JSON Web Signature (JWS): https://tools.ietf.org/html/rfc7515
 * 2. JSON Web Key (JWK): https://tools.ietf.org/html/rfc7517
 *
 *
 * Docker calls the "signatures" value the "JWS", a JSON Web Signature.
 * That's mostly accurate. A JWS, using the JSON serialization that
 * Docker is using, looks like:
 *
 *      {
 *          "payload": "<base64url-encoded payload bytes>",
 *          "signatures": [
 *              {
 *                  "signature": "<base64url-encoded signature>",
 *                  // One or both of "protected" and "header" must be
 *                  // included, and an "alg" key (the signing algoritm)
 *                  // must be in one of them.
 *                  "protected": "<base64url-encoded header key/value pairs
 *                      included in the signature>",
 *                  "header": {
 *                      <key/value pairs *not* included in the signature>
 *                   }
 *              }
 *          ]
 *      }
 *
 * (I'm eliding some details: If there is only one signature, then the
 * signature/protected/et al fields can be raised to the top-level. There
 * is a "compact" serialization that we don't need to worry about,
 * other than most node.js JWS modules don't directly support the JSON
 * serialization. There are other optional signature fields.)
 *
 * I said "mostly accurate", because the "payload" is missing. Docker
 * flips the JWS inside out, so that the "signatures" are include *in
 * the payload*. The "protected" header provides some data needed to
 * tease the signing payload out of the HTTP response body. Using our
 * example:
 *
 *      $ echo eyJmb3JtYXRMZW5ndGgiOjE2NzUsImZvcm1hdFRhaWwiOiJDbjAiLCJ0aW1lIjoiMjAxNS0wOS0xMFQyMzoyODowNloifQ | ./node_modules/.bin/base64url --decode
 *      {"formatLength":1675,"formatTail":"Cn0","time":"2015-09-10T23:28:06Z"}
 *
 * Here "formatLength" is a byte count into the response body to extract
 * and "formatTail" is a base64url-encoded suffix to append to that. In
 * practice the "formatLength" is up to comma before the "signatures" key
 * and "formatLength" is:
 *
 *      > base64url.decode('Cn0')
 *      '\n}'
 *
 * Meaning the signing payload is typically the equivalent of
 * `delete body["signatures"]`:
 *
 *      {
 *         "schemaVersion": 1,
 *         "name": "library/alpine",
 *         "tag": "latest",
 *         "architecture": "amd64",
 *         "fsLayers": ...,
 *         "history": ...
 *      }
 *
 * However, whitespace is significant because we are just signing bytes,
 * so the raw response body must be manipulated. An odd factoid is that
 * docker/libtrust seems to default to 3-space indentation:
 * <https://github.com/docker/libtrust/blob/9cbd2a1374f46905c68a4eb3694a130610adc62a/jsonsign.go#L450>
 * Perhaps to avoid people getting lucky.
 *
 */
/* END JSSTYLED */
function jwsFromManifest(manifest, body) {
    assert.object(manifest, 'manifest');
    assert.buffer(body, 'body');

    var formatLength;
    var formatTail;
    var jws = {
        signatures: []
    };

    for (var i = 0; i < manifest.signatures.length; i++) {
        var sig = manifest.signatures[i];

        try {
            var protectedHeader = JSON.parse(
                base64url.decode(sig['protected']));
        } catch (protectedErr) {
            throw new restify.InvalidContentError(protectedErr, fmt(
                'could not parse manifest "signatures[%d].protected": %j',
                i, sig['protected']));
        }
        if (isNaN(protectedHeader.formatLength)) {
            throw new restify.InvalidContentError(fmt(
                'invalid "formatLength" in "signatures[%d].protected": %j',
                i, protectedHeader.formatLength));
        } else if (formatLength === undefined) {
            formatLength = protectedHeader.formatLength;
        } else if (protectedHeader.formatLength !== formatLength) {
            throw new restify.InvalidContentError(fmt(
                'conflicting "formatLength" in "signatures[%d].protected": %j',
                i, protectedHeader.formatLength));
        }

        if (!protectedHeader.formatTail ||
            typeof (protectedHeader.formatTail) !== 'string')
        {
            throw new restify.InvalidContentError(fmt(
                'missing "formatTail" in "signatures[%d].protected"', i));
        }
        var formatTail_ = base64url.decode(protectedHeader.formatTail);
        if (formatTail === undefined) {
            formatTail = formatTail_;
        } else if (formatTail_ !== formatTail) {
            throw new restify.InvalidContentError(fmt(
                'conflicting "formatTail" in "signatures[%d].protected": %j',
                i, formatTail_));
        }

        var jwsSig = {
            header: {
                alg: sig.header.alg,
                chain: sig.header.chain
            },
            signature: sig.signature,
            'protected': sig['protected']
        };
        if (sig.header.jwk) {
            try {
                jwsSig.header.jwk = jwkToPem(sig.header.jwk);
            } catch (jwkErr) {
                throw new restify.InvalidContentError(jwkErr, fmt(
                    'error in "signatures[%d].header.jwk": %s',
                    i, jwkErr.message));
            }
        }
        jws.signatures.push(jwsSig);
    }

    jws.payload = Buffer.concat([
        body.slice(0, formatLength),
        new Buffer(formatTail)
    ]);

    return jws;
}


/*
 * Verify the 'Docker-Content-Digest' header for a getManifest response.
 *
 * @throws {BadDigestError} if the digest doesn't check out.
 */
function verifyManifestDockerContentDigest(res, jws) {
    var dcd = res.headers['docker-content-digest'];
    if (!dcd) {
        throw new restify.BadDigestError(
            'missing "Docker-Content-Digest" header');
    }

    // E.g. docker-content-digest: sha256:887f7ecfd0bda3...
    var parts = strsplit(dcd, ':', 2);
    if (parts.length !== 2) {
        throw new restify.BadDigestError(
            'could not parse "Docker-Content-Digest" header: ' + dcd);
    }

    var hash;
    try {
        hash = crypto.createHash(parts[0]);
    } catch (hashErr) {
        throw new restify.BadDigestError(hashErr, fmt(
            '"Docker-Content-Digest" header error: %s: %s',
            hashErr.message, dcd));
    }
    var expectedDigest = parts[1];

    hash.update(jws.payload);
    var digest = hash.digest('hex');
    if (hash && expectedDigest !== digest) {
        res.log.trace({expectedDigest: expectedDigest, header: dcd,
            digest: digest}, 'Docker-Content-Digest failure');
        throw new restify.BadDigestError('Docker-Content-Digest');
    }
}


/*
 * Verify a manifest JWS (JSON Web Signature)
 *
 * This mimicks
 *      func Verify(sm *SignedManifest) ([]libtrust.PublicKey, error)
 * in "docker/vendor/src/github.com/docker/distribution/manifest/verify.go"
 * which calls
 *      func (js *JSONSignature) Verify() ([]PublicKey, error)
 * in "docker/vendor/src/github.com/docker/libtrust/jsonsign.go"
 *
 * TODO: find an example with `signatures.*.header.chain` to test that path
 *
 * @param jws {Object} A JWS object parsed from `jwsFromManifest`.
 * @throws {errors.ManifestVerificationError} if there is a problem.
 */
function verifyJws(jws) {
    var encodedPayload = base64url(jws.payload);

    /*
     * Disallow the "none" algorithm because while the `jws` module might have
     * a guard against
     *      // JSSTYLED
     *      https://auth0.com/blog/2015/03/31/critical-vulnerabilities-in-json-web-token-libraries/
     * why bother allowing it?
     */
    var disallowedAlgs = ['none'];

    for (var i = 0; i < jws.signatures.length; i++) {
        var jwsSig = jws.signatures[i];
        var alg = jwsSig.header.alg;
        if (disallowedAlgs.indexOf(alg) !== -1) {
            throw new errors.ManifestVerificationError(
                {jws: jws, i: i}, 'disallowed JWS signature algorithm:', alg);
        }

        // TODO: Find Docker manifest example using 'header.chain'
        // and implement this. See "jsonsign.go#Verify".
        if (jwsSig.header.chain) {
            throw new errors.InternalError({jws: jws, i: i},
                'JWS verification with a cert "chain" is not implemented: %j',
                jwsSig.header.chain);
        }

        // `mod_jws.verify` takes the JWS compact representation.
        var jwsCompact = jwsSig['protected'] + '.' + encodedPayload +
            '.' + jwsSig.signature;
        var verified = mod_jws.verify(jwsCompact, alg, jwsSig.header.jwk);
        if (!verified) {
            throw new errors.ManifestVerificationError(
                {jws: jws, i: i}, 'JWS signature %d failed verification', i);
        }
    }
}



// --- RegistryClientV2

/**
 * Create a new Docker Registry V2 client for a particular repository.
 *
 * ...
 * @param opts.insecure {Boolean} Optional. Default false. Set to true
 *      to *not* fail on an invalid or self-signed server certificate.
 * @param agent Optional. See
 *      // JSSTYLED
 *      <https://nodejs.org/docs/latest/api/all.html#all_https_request_options_callback>
 *      CLIs likely will want to use `agent: false`.
 * ...
 *
 */
function RegistryClientV2(opts) {
    var self = this;
    assert.object(opts, 'opts');
    assert.string(opts.name, 'opts.name');
    assert.optionalObject(opts.log, 'opts.log');
    assert.optionalString(opts.username, 'opts.username');
    assert.optionalString(opts.password, 'opts.password');
    assert.optionalString(opts.token, 'opts.token');  // for Bearer auth
    assert.optionalBool(opts.insecure, 'opts.insecure');
    assert.optionalString(opts.scheme, 'opts.scheme');
    // TODO: options to control the trust db for CA verification
    // TODO add passing through other restify options: userAgent, ...
    // Restify/Node HTTP client options.
    assert.optionalBool(opts.agent, 'opts.agent');
    assert.optionalString(opts.userAgent, 'opts.userAgent');

    this.userAgent = opts.userAgent || common.DEFAULT_USERAGENT;
    this.log = opts.log
        ? opts.log.child({
                component: 'registry',
                serializers: restify.bunyan.serializers
            })
        : bunyan.createLogger({
                name: 'registry',
                serializers: restify.bunyan.serializers
            });

    this.insecure = Boolean(opts.insecure);
    this.repo = common.parseRepo(opts.name);
    if (opts.scheme) {
        this.repo.index.scheme = opts.scheme;
    } else if (common.isLocalhost(this.repo.index.name)) {
        // Per docker.git:registry/config.go#NewServiceConfig we special
        // case localhost to allow HTTP. Note that this lib doesn't do
        // the "try HTTPS, then fallback to HTTP if allowed" thing that
        // Docker-docker does, we'll just prefer HTTP for localhost.
        this.repo.index.scheme = 'http';
    }

    this._loggedIn = false;
    this._authChallenge = null;
    this._authErr = null;
    this._headers = {};
    if (opts.username && opts.password) {
        var buffer = new Buffer(opts.username + ':' + opts.password, 'utf8');
        this._headers.authorization = 'Basic ' + buffer.toString('base64');
        this._username = opts.username;
    } else if (opts.token) {
        this._headers.authorization = 'Bearer ' + opts.token;
    }
    // XXX relevant for v2?
    //this._cookieJar = new tough.CookieJar();

    if (this.repo.index.official) {  // v1
        this._url = DEFAULT_REGISTRY_URL_V2;
    } else {
        this._url = common.urlFromIndex(this.repo.index);
    }

    Object.defineProperty(this, '_api', {
        get: function () {
            if (self.__api === undefined) {
                self.__api = new DockerJsonClient({
                    url: self._url,
                    log: self.log,
                    agent: opts.agent,
                    rejectUnauthorized: !this.insecure,
                    userAgent: self.userAgent
                });
            }
            return this.__api;
        }
    });
    Object.defineProperty(this, '_rawApi', {
        get: function () {
            if (self.__rawApi === undefined) {
                // XXX Will want this to be a Docker-Content-Digest-checking
                // client too
                self.__rawApi = restify.createHttpClient({
                    url: self._url,
                    log: self.log,
                    agent: opts.agent,
                    rejectUnauthorized: !this.insecure,
                    userAgent: self.userAgent
                });
            }
            return this.__rawApi;
        }
    });
}


/**
 * Get a registry session token from docker.io.
 *
 * Getting repo auth involves hitting the `listRepoImgs` endpoint
 * to get a 'X-Docker-Token' header. While the *body* of that
 * response is not the goal, it *can* provide useful information: some
 * more recent images include a checksum that can be useful for later
 * downloads, e.g. this extract for the busybox repo:
 *
 *      {
 *          "checksum": "tarsum+sha256:32abf29cb55c24e05ae534...117b0f44c98518",
 *          "id": "a943c4969b70574bb546a26bb28dc880...878f6e61be553de0aee1e61"
 *      },
 *
 * Currently we are throwing away that info. Registry API v2 might do away
 * with this double duty.
 *
 * Side-effects:
 * - `this.token` and `this._headers.Authorization` are set, if successful
 * - `this.endpoints` is set if the response headers include
 *   "X-Docker-Endpoints".
 */
RegistryClientV2.prototype._login = function _login(cb) {
    var self = this;
    if (this._loggedIn) {
        return cb();
    }

    var log = this.log;
    log.trace('login');

    vasync.pipeline({funcs: [
        function ensureAuthChallenge(_, next) {
            if (self._authChallenge) {
                return next();
            }
            self.ping(function (err, body, res) {
                if (!err) {
                    assert(this._loggedIn, 'expected 200 and now logged in');
                    next(true);  // early pipeline abort
                } else if (res && res.statusCode === 401) {
                    assert.ok(self._authChallenge, '_authChallenge now set');
                    next();
                } else {
                    next(err);
                }
            });
        },

        function basicAuth(_, next) {
            if (self._authChallenge.scheme.toLowerCase() !== 'basic') {
                return next();
            }

            /*
             * If the scheme is Basic, then we should already have failed
             * because username/password would have been in the original Ping.
             */
            log.debug('basicAuth fail');
            next(self._authErr);
        },

        function bearerAuth(_, next) {
            if (self._authChallenge.scheme.toLowerCase() !== 'bearer') {
                return next();
            }
            log.debug({challenge: self._authChallenge},
                'login: get Bearer auth token');

            var resource = 'repository';
            // TODO: actions should be passed in to _login from endpoint,
            // then we need to cache that with `self._token`. Store the
            // 'scopes'. To know if need a *new* token. Then perhaps it
            // isn't "this._loggedIn" but "have sufficient token"?
            var actions = ['pull'];
            var scope = fmt('%s:%s:%s', resource, self.repo.remoteName,
                actions.join(','));
            _getToken({
                log: self.log,
                indexName: self.repo.index.name,
                insecure: self.insecure,
                realm: self._authChallenge.parms.realm,
                service: self._authChallenge.parms.service,
                scopes: [scope],
                username: self.username,
                password: self.password
            }, function (err, token) {
                if (err) {
                    next(err);
                }
                log.debug({token: token}, 'login: Bearer auth token');
                self._headers.authorization = 'Bearer ' + token;
                self._loggedIn = true;
                next(true); // early pipeline abort
            });
        },

        function unknownAuthScheme(_, next) {
            next(new Error(fmt('unsupported auth scheme: "%s"',
                self._authChallenge.scheme)));
        }

    ]}, function (err) {
        if (err === true) {
            err = null;
        }
        log.trace({err: err, loggedIn: this._loggedIn}, 'done login attempt');
        cb(err);
    });
};

RegistryClientV2.prototype.version = 2;


RegistryClientV2.prototype.close = function close() {
    if (this.__api) {
        this.__api.close();
    }
    if (this.__rawApi) {
        this.__rawApi.close();
    }
};


//RegistryClientV2.prototype._saveCookies = function _saveCookies(url, res) {
//    var header = res.headers['set-cookie'];
//    if (!header) {
//        return;
//    }
//
//    var cookie;
//    if (Array.isArray(header)) {
//        for (var i = 0; i < header.length; i++) {
//            cookie = tough.Cookie.parse(header[i]);
//            this._cookieJar.setCookieSync(cookie, url);
//        }
//    } else {
//        cookie = tough.Cookie.parse(header[i]);
//        this._cookieJar.setCookieSync(cookie, url);
//    }
//};
//
//
//RegistryClientV2.prototype._getCookies = function _getCookies(url) {
//    var cookies = this._cookieJar.getCookiesSync(url);
//    if (cookies.length) {
//        return cookies.join('; ');
//    }
//};


/**
 * Ping the base URL.
 * https://docs.docker.com/registry/spec/api/#base
 *
 * There are two side-effects used for `_login()`:
 * - status 200: set `this._loggedIn = true`
 * - status 401: set `this._authChallenge` from the WWW-Authenticate header
 *   and set `this._authErr`.
 */
RegistryClientV2.prototype.ping = function ping(cb) {
    var self = this;
    assert.func(cb, 'cb');

    this._api.get({
        path: '/v2/',
        headers: self._headers,
        // Ping should be fast. We don't want 15s of retrying.
        retry: false
    }, function _afterPing(err, req, res, body) {
        if (res && res.statusCode === 401) {
            // Store WWW-Authenticate challenges for later use.
            try {
                self._authChallenge = _parseAuthChallenge(res);
            } catch (e) {
                self.log.debug(e, 'ignore unparseable WWW-Authenticate');
            }
        }
        if (err) {
            self._authErr = err; // Save for possible use in `_login` later.
            return cb(err, body, res);
        }
        if (res.statusCode === 200) {
            self._loggedIn = true;
        }
        return cb(null, body, res);
    });
};


/**
 * Determine if this registry supports the v2 API.
 * https://docs.docker.com/registry/spec/api/#api-version-check
 *
 * Note that, at least, currently we are presuming things are fine with a 401.
 * I.e. defering auth to later calls.
 *
 * @param cb {Function} `function (err, supportsV2)`
 *      where `supportsV2` is a boolean indicating if V2 API is supported.
 */
RegistryClientV2.prototype.supportsV2 = function supportsV2(cb) {
    this.ping(function (err, body, res) {
        if (res && (res.statusCode === 200 || res.statusCode === 401)) {
            var header = res.headers['docker-distribution-api-version'];
            if (header) {
                var versions = header.split(/\s+/g);
                if (versions.indexOf('registry/2.0') !== -1) {
                    return cb(null, true);
                }
            }
        }
        cb(null, false);
    });
};


RegistryClientV2.prototype.listTags = function listTags(cb) {
    var self = this;
    assert.func(cb, 'cb');

    var res, repoTags;
    vasync.pipeline({arg: this, funcs: [
        login,
        function call(_, next) {
            self._api.get({
                path: fmt('/v2/%s/tags/list',
                    encodeURI(self.repo.remoteName)),
                headers: self._headers
            }, function _afterCall(err, req, res_, repoTags_) {
                if (err) {
                    return next(err);
                }
                repoTags = repoTags_;
                res = res_;
                next();
            });
        }
    ]}, function (err) {
        cb(err, repoTags, res);
    });
};

/*
 * Get an image manifest. `ref` is either a tag or a digest.
 *
 * <https://docs.docker.com/registry/spec/api/#pulling-an-image-manifest>
 */
RegistryClientV2.prototype.getManifest = function getManifest(opts, cb) {
    var self = this;
    assert.object(opts, 'opts');
    assert.string(opts.ref, 'opts.ref');
    assert.func(cb, 'cb');

    var res, manifest;
    vasync.pipeline({arg: this, funcs: [
        login,
        function call(_, next) {
            self._api.get({
                path: fmt('/v2/%s/manifests/%s',
                    encodeURI(self.repo.remoteName),
                    encodeURIComponent(opts.ref)),
                headers: self._headers
            }, function _afterCall(err, req, res_, manifest_, body) {
                if (err) {
                    return next(err);
                }

                try {
                    var jws = jwsFromManifest(manifest_, body);
                    verifyManifestDockerContentDigest(res_, jws);
                    verifyJws(jws);
                } catch (verifyErr) {
                    return next(verifyErr);
                }

                if (manifest_.schemaVersion !== 1) {
                    throw new restify.InvalidContentError(fmt(
                        'unsupported schema version %s in %s:%s manifest',
                        manifest_.schemaVersion, self.repo.localName,
                        opts.ref));
                }
                if (manifest_.fsLayers.length !== manifest_.history.length) {
                    throw new restify.InvalidContentError(fmt(
                        'length of history not equal to number of layers in ' +
                        '%s:%s manifest', self.repo.localName, opts.ref));
                }
                if (manifest_.fsLayers.length === 0) {
                    throw new restify.InvalidContentError(fmt(
                        'no layers in %s:%s manifest', self.repo.localName,
                        opts.ref));
                }

                // TODO: `verifyTrustedKeys` from
                // docker/graph/pull_v2.go#validateManifest()

                manifest = manifest_;
                res = res_;
                next();
            });
        }
    ]}, function (err) {
        cb(err, manifest, res);
    });
};


/*
 * Get an image file blob -- just the headers. See `getBlob`.
 *
 * <https://docs.docker.com/registry/spec/api/#get-blob>
 * <https://docs.docker.com/registry/spec/api/#pulling-an-image-manifest>
 *
 * This endpoint can return 3xx redirects. An example first hit to Docker Hub
 * yields this response
 *
 *      HTTP/1.1 307 Temporary Redirect
 *      docker-content-digest: sha256:b15fbeba7181d178e366a5d8e0...
 *      docker-distribution-api-version: registry/2.0
 *      location: https://dseasb33srnrn.cloudfront.net/registry-v2/...
 *      date: Mon, 01 Jun 2015 23:43:55 GMT
 *      content-type: text/plain; charset=utf-8
 *      connection: close
 *      strict-transport-security: max-age=3153600
 *
 * And after resolving redirects, this:
 *
 *      HTTP/1.1 200 OK
 *      Content-Type: application/octet-stream
 *      Content-Length: 2471839
 *      Connection: keep-alive
 *      Date: Mon, 01 Jun 2015 20:23:43 GMT
 *      Last-Modified: Thu, 28 May 2015 23:02:16 GMT
 *      ETag: "f01c599df7404875a0c1740266e74510"
 *      Accept-Ranges: bytes
 *      Server: AmazonS3
 *      Age: 11645
 *      X-Cache: Hit from cloudfront
 *      Via: 1.1 e3799a12d0e2fdaad3586ff902aa529f.cloudfront.net (CloudFront)
 *      X-Amz-Cf-Id: 8EUekYdb8qGK48Xm0kmiYi1GaLFHbcv5L8fZPOUWWuB5zQfr72Qdfg==
 *
 * A client will typically want to follow redirects, so by default we
 * follow redirects and return a responses. If needed a `opts.noFollow=true`
 * could be implemented.
 *
 *      cb(err, ress)   // `ress` is the plural of `res` for "response"
 *
 * Interesting headers:
 * - `ress[0].headers['docker-content-digest']` is the digest of the
 *   content to be downloaded
 * - `ress[-1].headers['content-length']` is the number of bytes to download
 * - `ress[-1].headers[*]` as appropriate for HTTP caching, range gets, etc.
 */
RegistryClientV2.prototype.headBlob = function headBlob(opts, cb) {
    var self = this;
    assert.object(opts, 'opts');
    assert.string(opts.digest, 'opts.digest');
    assert.func(cb, 'cb');

    var ress = [];

    vasync.pipeline({arg: this, funcs: [
        login,
        function call(_, next) {
            // We want a non-redirect (i.e. non-3xx) response to return. Use a
            // barrier to gate that.
            var barrier = vasync.barrier();
            barrier.on('drain', function _onGetNonRedirResult() {
                self.log.trace({res: ress[ress.length - 1], imgId: opts.imgId},
                    'got a non-redir response');
                next(null, ress);
            });

            var MAX_NUM_REDIRS = 3;
            var numRedirs = 0;
            function makeReq(reqOpts) {
                if (numRedirs >= MAX_NUM_REDIRS) {
                    next(new Error(fmt('maximum number of redirects (%s) hit ' +
                        'when attempt to get image blob for image digest %s',
                        MAX_NUM_REDIRS, opts.digest)));
                    return;
                }
                numRedirs += 1;

                var client = restify.createHttpClient({
                    url: reqOpts.url,
                    log: self.log,
                    agent: false,
                    rejectUnauthorized: !self.insecure,
                    userAgent: self.userAgent
                });
                client.head(reqOpts, function _onConn(connErr, req) {
                    if (connErr) {
                        next(connErr);
                        return;
                    }
                    req.on('result', function (err, res) {
                        ress.push(res);
                        if (err) {
                            next(err);
                            return;
                        }
                        if (res.statusCode === 302 || res.statusCode === 307) {
                            var loc = mod_url.parse(res.headers.location);
                            makeReq({
                                url: loc.protocol + '//' + loc.host,
                                path: loc.path
                            });
                        } else {
                            barrier.done('nonRedirRes');
                        }
                    });
                });
            }

            barrier.start('nonRedirRes');
            makeReq({
                url: self._url,
                path: fmt('/v2/%s/blobs/%s',
                    encodeURI(self.repo.remoteName),
                    encodeURIComponent(opts.digest)),
                headers: self._headers
            }, next);
        }
    ]}, function (err) {
        cb(err, ress);
    });
};





/**
 * XXX
 * // JSSTYLED
 * <https://docs.docker.com/reference/api/registry_api/#get-image-id-for-a-particular-tag>
 */
RegistryClientV2.prototype.getImgId = function getImgId(opts, cb) {
    var self = this;
    assert.object(opts, 'opts');
    assert.string(opts.tag, 'opts.tag');
    assert.func(cb, 'cb');

    var res, imgId;
    vasync.pipeline({arg: this, funcs: [
        login,
        function call(_, next) {
            self._api.get({
                path: fmt('/v1/repositories/%s/tags/%s',
                    encodeURI(self.repo.remoteName),
                    encodeURIComponent(opts.tag)),
                headers: self._headers
            }, function _afterCall(err, req, res_, imgId_) {
                if (err) {
                    return next(err);
                }
                self._saveCookies(self._url + req.path, res_);
                imgId = imgId_;
                res = res_;
                next();
            });
        }
    ]}, function (err) {
        cb(err, imgId, res);
    });
};


/**
 * XXX
 * Gets the image's ancestry: all of the image layers that are required for
 * it to be functional.
 */
RegistryClientV2.prototype.getImgAncestry = function getImgAncestry(opts, cb) {
    var self = this;
    assert.object(opts, 'opts');
    assert.string(opts.imgId, 'opts.imgId');
    assert.func(cb, 'cb');

    var res, ancestry;
    vasync.pipeline({arg: this, funcs: [
        login,
        function call(_, next) {
            var pth = fmt('/v1/images/%s/ancestry',
                    encodeURIComponent(opts.imgId));
            self._api.get({
                path: pth,
                headers: common.objMerge({
                    cookie: self._getCookies(self._url + pth)
                }, self._headers)
            }, function _afterCall(err, req, res_, ancestry_) {
                if (err) {
                    return next(err);
                }
                ancestry = ancestry_;
                res = res_;
                next();
            });
        }
    ]}, function (err) {
        cb(err, ancestry, res);
    });
};


/**
 * XXX
 * Gets the image's JSON (i.e. its metadata).
 * Though a poor name, IMHO, docker.git/registry/session.go calls it the image
 * "JSON".
 */
RegistryClientV2.prototype.getImgJson = function getImgJson(opts, cb) {
    var self = this;
    assert.object(opts, 'opts');
    assert.string(opts.imgId, 'opts.imgId');
    assert.func(cb, 'cb');

    var res, imgJson;
    vasync.pipeline({arg: this, funcs: [
        login,
        function call(_, next) {
            self._api.get({
                path: fmt('/v1/images/%s/json',
                    encodeURIComponent(opts.imgId)),
                headers: self._headers
            }, function _afterCall(err, req, res_, imgJson_) {
                if (err) {
                    return next(err);
                }
                imgJson = imgJson_;
                res = res_;
                next();
            });
        }
    ]}, function (err) {
        cb(err, imgJson, res);
    });
};


/**
 * XXX
 * Get a *paused* readable stream to the given image's layer.
 *
 * Possible usage (skips error handling, see "examples/downloadImgLayer.js"):
 *
 *      client.getImgLayerStream({imgId: '...'}, function (err, stream) {
 *          var fout = fs.createWriteStream('/var/tmp/layer.file');
 *          fout.on('finish', function () {
 *              console.log('Done downloading image layer');
 *          });
 *          stream.pipe(fout);
 *          stream.resume();
 *      });
 *
 * @param opts {Object}
 *      - imgId {String}
 * @param cb {Function} `function (err, stream)`
 *      The `stream` is also an HTTP response object, i.e. headers are on
 *      `stream.headers`.
 */
RegistryClientV2.prototype.getImgLayerStream =
function getImgLayerStream(opts, cb) {
    var self = this;
    assert.object(opts, 'opts');
    assert.string(opts.imgId, 'opts.imgId');
    assert.func(cb, 'cb');

    var nonRedirRes;

    vasync.pipeline({arg: this, funcs: [
        login,
        function call(_, next) {
            // We want a non-redirect (i.e. non-3xx) response to return. Use a
            // barrier to gate that.
            var barrier = vasync.barrier();
            barrier.on('drain', function _onGetNonRedirResult() {
                self.log.trace({res: nonRedirRes, imgId: opts.imgId},
                    'got a non-redir response');
                common.pauseStream(nonRedirRes); // party like it's node 0.10
                next(null, nonRedirRes);
            });

            var MAX_NUM_REDIRS = 3;
            var numRedirs = 0;
            function makeReq(reqOpts) {
                if (numRedirs >= MAX_NUM_REDIRS) {
                    next(new Error(fmt('maximum number of redirects (%s) hit ' +
                        'when attempt to get image layer stream for image %s',
                        MAX_NUM_REDIRS, opts.imgId)));
                    return;
                }
                numRedirs += 1;

                var client = restify.createHttpClient({
                    url: reqOpts.url,
                    log: self.log,
                    agent: false,
                    rejectUnauthorized: !self.insecure
                });
                client.get(reqOpts, function _onConn(connErr, req) {
                    if (connErr) {
                        next(connErr);
                        return;
                    }
                    req.on('result', function (resultErr, res) {
                        if (resultErr) {
                            next(resultErr);
                            return;
                        }
                        if (res.statusCode === 302) {
                            var loc = mod_url.parse(res.headers.location);
                            makeReq({
                                url: loc.protocol + '//' + loc.host,
                                path: loc.path
                            });
                        } else {
                            nonRedirRes = res;
                            barrier.done('nonRedirRes');
                        }
                    });
                });
            }

            barrier.start('nonRedirRes');
            makeReq({
                url: self._url,
                path: fmt('/v1/images/%s/layer',
                    encodeURIComponent(opts.imgId)),
                headers: self._headers
            }, next);
        }
    ]}, function (err) {
        cb(err, nonRedirRes);
    });
};


// --- Exports

function createClient(opts) {
    return new RegistryClientV2(opts);
}

module.exports = {
    createClient: createClient
};