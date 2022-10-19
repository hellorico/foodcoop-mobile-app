import {KEYUTIL, KJUR} from 'jsrsasign';
import JwtDecode from 'jwt-decode';
import {AuthConfiguration, authorize, AuthorizeResult, refresh, RefreshResult} from 'react-native-app-auth';
import * as Sentry from '@sentry/react-native';
import RNSecureStorage, {ACCESSIBLE} from 'rn-secure-storage';
import {Button, ButtonProps} from 'react-native';
import React, {Component, ReactElement} from 'react';
import Mailjet from './Mailjet';
import Config from 'react-native-config';

interface TokenInfo {
    iss: string;
    iat: number;
    exp: number;
    auth_time: number;
    nonce: string;
    at_hash: string;
}

interface User {
    email: string;
    sub: string;
    name: string;
    given_name: string;
    picture: string;
}

interface SupercoopKey {
    alg: string;
    e: string;
    kid?: string;
    kty: string;
    n: string;
    use: string;
}

interface SupercoopJWKsResponse {
    keys: SupercoopKey[];
}

export default class SupercoopSignIn {
    private static instance: SupercoopSignIn;
    private currentUser?: User;
    private PEMs: string[] = [];

    config: AuthConfiguration = {
        issuer: Config.OPENID_CONNECT_ISSUER,
        clientId: Config.OPENID_CONNECT_CLIENT_ID,
        redirectUrl: Config.OPENID_CONNECT_REDIRECT_URL,
        scopes: ['openid', 'profile', 'email'],
        usePKCE: true,
        useNonce: true,
    };

    public static getInstance(): SupercoopSignIn {
        if (SupercoopSignIn.instance === undefined) {
            SupercoopSignIn.instance = new SupercoopSignIn();
        }

        return this.instance;
    }

    constructor() {
        this.currentUser = undefined;
    }

    async fetchJwks(): Promise<void> {
        if (this.PEMs.length === 0) {
            const result = await fetch(`${this.config.issuer}/oauth/jwks.json`);
            const json = (await result.json()) as SupercoopJWKsResponse;
            json.keys.forEach(key => {
                const keyObj = KEYUTIL.getKey(key);
                this.PEMs.push(KEYUTIL.getPEM(keyObj));
            });
        }
    }

    getName(): string {
        return this.currentUser?.name ?? 'John Doe';
    }

    getFirstname(): string | null {
        return this.currentUser ? this.currentUser.given_name : null;
    }

    getFirstnameSlug(): RegExpMatchArray | null {
        const email = this.getEmail();
        if (email === null) {
            return null;
        }
        return email.match(/^[^.]+/);
    }

    getEmail(): string {
        return this.currentUser?.email ?? 'john.doe@supercoop.fr';
    }

    getUserPhoto(): string | undefined {
        return undefined;
    }

    setCurrentUser(user?: User | undefined): void {
        // console.debug(user);
        this.currentUser = user;
        if (undefined !== user) {
            Sentry.setUser({email: user.email});
            Mailjet.getInstance().setSender(user.name);
        } else {
            Sentry.setUser(null);
            Mailjet.getInstance().setSender();
        }
    }

    signInSilently = async (): Promise<void> => {
        const {refreshToken, idToken} = await this.getTokensFromSecureStorage();
        // refresh token if needed and save user
        if (this.isTokenExpired(idToken)) {
            console.debug('signInSilently isTokenExpired true');
            // console.log(idToken);
            let result: any = null;
            try {
                // console.debug(this.config);
                result = await refresh(this.config, {refreshToken: refreshToken});
            } catch (error) {
                console.error(error);
            }
            if (result === null) {
                return Promise.reject(result);
            }

            let user = await this.getUserFromToken(result.idToken);
            this.saveTokensFromResult(result);
            this.setCurrentUser(user);
            return Promise.resolve();
        } else {
            // save user if defined
            let user = await this.getUserFromToken(idToken);
            if (undefined === user) {
                console.debug('reject(undefined user)');
                return Promise.reject('undefined user');
            } else {
                this.setCurrentUser(user);
                console.debug('setCurrentUser resolve');
                return Promise.resolve();
            }
        }
    };

    signIn = async (): Promise<void> => {
        const result = await authorize(this.config);
        // console.debug(result);
        const user = await this.getUserFromToken(result.idToken);
        this.saveTokensFromResult(result);
        this.setCurrentUser(user);
        return;
    };

    signOut = async (): Promise<void> => {
        this.setCurrentUser();
        await this.removeTokensFromSecureStorage();
    };

    isTokenExpired = (token: string): boolean => {
        const parsedToken: TokenInfo = JwtDecode<TokenInfo>(token);
        let now: number = new Date().getTime() / 1000;
        if (parsedToken?.exp === undefined || parsedToken?.exp < now) {
            return true;
        }
        return false;
    };

    async idTokenIsValid(token: string): Promise<boolean> {
        await this.fetchJwks();
        for (const pem of this.PEMs) {
            // console.debug('');
            // console.debug('token');
            // console.debug(token);
            // console.debug('pem');
            // console.debug(pem);
            // console.debug('');
            const isValid = KJUR.jws.JWS.verifyJWT(token, pem, {
                alg: ['RS256'],
                iss: [Config.OPENID_CONNECT_ISSUER],
            });
            // console.debug(isValid);
            // console.debug('');
            if (isValid === true) {
                return true;
            }
        }
        return false;
    }

    async getUserFromToken(token: string): Promise<User> {
        const tokenIsValid = await this.idTokenIsValid(token);
        if (tokenIsValid === true) {
            console.info('idToken is valid');
            return JwtDecode<User>(token);
        }
        throw new Error('Invalid idToken');
    }

    private async saveTokensFromResult(result: AuthorizeResult | RefreshResult): Promise<void> {
        if (result.refreshToken) {
            await RNSecureStorage.set('refreshToken', result.refreshToken, {accessible: ACCESSIBLE.WHEN_UNLOCKED});
        } else {
            await RNSecureStorage.remove('refreshToken');
        }
        await RNSecureStorage.set('idToken', result.idToken, {accessible: ACCESSIBLE.WHEN_UNLOCKED});
    }

    private async getTokensFromSecureStorage(): Promise<any> {
        const refreshToken = await RNSecureStorage.get('refreshToken');
        const idToken = await RNSecureStorage.get('idToken');

        return {refreshToken, idToken};
    }

    private async removeTokensFromSecureStorage(): Promise<void> {
        await RNSecureStorage.remove('refreshToken');
        await RNSecureStorage.remove('idToken');
    }
}

export class SupercoopSignInButton extends Component<ButtonProps, {}> {
    render(): ReactElement {
        return <Button title={this.props.title} onPress={this.props.onPress} disabled={this.props.disabled} />;
    }
}
