import {
  ApiClient,
  ConnectionFailure,
  isConnectionFailure,
  SynologyResponse,
} from 'synology-typescript-api';

const NO_PERMISSIONS_ERROR_CODE = 105;

// This state seems to happen when you don't touch the browser for a couple days: I guess the session token
// is invalidated in some fashion but the server doesn't respond with that error code, but instead this one.
export function wrapInNoPermissionsRetry<T extends (api: ApiClient, ...args: any[]) => Promise<ConnectionFailure | SynologyResponse<any>>>(fn: T): T {
  return function(api: ApiClient, ...args: any[]) {
    return fn(api, ...args)
      .then(result => {
        if (!isConnectionFailure(result) && !result.success && result.error.code === NO_PERMISSIONS_ERROR_CODE) {
          console.log(`request got permission failure, will retry once; args:`, args, 'result:', result);
          api.Auth.Logout();
          return fn(api, ...args);
        } else {
          return result;
        }
      });
  } as T;
}
