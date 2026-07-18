import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { environment } from '../../environments/environment';
import { UpstoxCredentialsService } from './upstox-credentials.service';
import axios from 'axios';

@Injectable({
  providedIn: 'root'
})
export class UpstoxService {

  private readonly API_BASE = 'https://api.upstox.com/v2';
  private accessToken: string | null = null;

  /** Reactive connection state — subscribe in components to react to connect/disconnect */
  public isConnected$ = new BehaviorSubject<boolean>(false);

  constructor(private credentials: UpstoxCredentialsService) {
    this.accessToken = localStorage.getItem('upstox_access_token');

    // Check initial connection state async
    this.getValidToken().then(token => {
      if (token) this.isConnected$.next(true);
    });
  }

  /** Returns the redirect URI based on current host (localhost vs production) */
  public getRedirectUri(): string {
    const isLocal = window.location.hostname === 'localhost';
    return isLocal
      ? 'http://localhost:4200/auth/upstox'
      : `${window.location.origin}/algo-trading/auth/upstox`;
  }

  /** Gets API key from Firestore cache → env fallback */
  private getApiKey(): string {
    return this.credentials.getCached()?.apiKey || '';
  }

  private getApiSecret(): string {
    return this.credentials.getCached()?.apiSecret || '';
  }

  // 1. Redirect user to Upstox Login Page
  public login(): void {
    const clientId = this.getApiKey();
    const redirectUri = this.getRedirectUri();
    const authUrl = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    window.location.href = authUrl;
  }

  // 2. Handle the redirect back from Upstox with the 'code'
  public async handleAuthCallback(code: string): Promise<boolean> {
    try {
      const clientId = this.getApiKey();
      const redirectUri = this.getRedirectUri();
      const secret = this.getApiSecret();

      // DIAGNOSTIC — open browser console to verify these match your Upstox app settings
      console.log('━━━━━ Upstox Token Exchange ━━━━━');
      console.log('client_id   :', clientId);
      console.log('redirect_uri:', redirectUri);
      console.log('secret set  :', secret ? `yes (${secret.length} chars)` : 'NO — missing!');
      console.log('code        :', code?.slice(0, 12) + '…');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      const data = new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: secret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      });

      const response = await axios.post(`https://api.upstox.com/v2/login/authorization/token`, data, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        }
      });

      this.accessToken = response.data.access_token;
      if (this.accessToken) {
        localStorage.setItem('upstox_access_token', this.accessToken);
        this.isConnected$.next(true);   // notify all subscribers immediately

        // --- ADMIN / SUPERUSER LOGIC ---
        const isSuper = await this.credentials.isSuperUser();
        if (isSuper) {
          await this.credentials.saveGlobalAccessToken(this.accessToken);
        }

        return true;
      }
      return false;

    } catch (error: any) {
      console.error('Upstox token exchange failed:', error?.response?.data || error?.message);
      return false;
    }
  }

  // Ensure we have a valid token (local or global)
  public async getValidToken(): Promise<string | null> {
    if (this.accessToken) {
      console.log('UPSTOX_TOKEN_LOG:', this.accessToken);
      return this.accessToken;
    }

    let localToken = localStorage.getItem('upstox_access_token');
    if (localToken) {
      this.accessToken = localToken;
      console.log('UPSTOX_TOKEN_LOG:', localToken);
      return localToken;
    }

    const globalToken = await this.credentials.getGlobalAccessToken();
    if (globalToken) {
      this.accessToken = globalToken;
      console.log('UPSTOX_TOKEN_LOG:', globalToken);
      return globalToken;
    }

    return null;
  }

  // Helper method to make authenticated API calls
  public async getProfile(forceLocal: boolean = false): Promise<any> {
    let token: string | null = null;

    if (forceLocal) {
      token = localStorage.getItem('upstox_access_token');
    } else {
      token = await this.getValidToken();
    }

    if (!token) {
      console.warn('[UpstoxService] No local or global token available for profile fetch');
      return null;
    }
    const response = await axios.get(`${this.API_BASE}/user/profile`, {
      headers: {
        'Api-Version': '2.0',
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });
    return response.data;
  }

  public logout(): void {
    this.accessToken = null;
    localStorage.removeItem('upstox_access_token');
    // If they log out of their personal account, we check if there's still a global token fallback
    this.getValidToken().then(token => {
      this.isConnected$.next(!!token);
    });
  }

  public hasLocalToken(): boolean {
    return !!localStorage.getItem('upstox_access_token');
  }

  public async isLoggedIn(): Promise<boolean> {
    return (await this.getValidToken()) !== null;
  }
}
