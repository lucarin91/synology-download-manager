import { uniqueId, find } from 'lodash-es';
import Axios from 'axios';
import {
  ApiClient,
  ConnectionFailure,
  isConnectionFailure,
  SynologyResponse,
  DownloadStationTaskCreateRequest,
  FormFile,
  isFormFile
} from 'synology-typescript-api';
import { errorMessageFromCode, errorMessageFromConnectionFailure } from './apiErrors';
import { CachedTasks } from './state';
import { notify } from './browserApi';

const NO_PERMISSIONS_ERROR_CODE = 105;

// This state seems to happen when you don't touch the browser for a couple days: I guess the session token
// is invalidated in some fashion but the server doesn't respond with that error code, but instead this one.
function wrapInNoPermissionsRetry<T extends (api: ApiClient, ...args: any[]) => Promise<ConnectionFailure | SynologyResponse<any>>>(fn: T): T {
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

export function clearCachedTasks() {
  const emptyState: CachedTasks = {
    tasks: [],
    taskFetchFailureReason: null,
    tasksLastCompletedFetchTimestamp: null,
    tasksLastInitiatedFetchTimestamp: null
  };

  return browser.storage.local.set(emptyState);
}

const doTaskPoll = wrapInNoPermissionsRetry((api: ApiClient) => {
  return api.DownloadStation.Task.List({
    offset: 0,
    limit: -1,
    additional: [ 'transfer' ],
    timeout: 20000
  });
});

export function pollTasks(api: ApiClient): Promise<void> {
  const cachedTasksInit: Partial<CachedTasks> = {
    tasksLastInitiatedFetchTimestamp: Date.now()
  };

  const pollId = uniqueId('poll-');
  console.log(`(${pollId}) polling for tasks...`);

  return Promise.all([
    browser.storage.local.set(cachedTasksInit),
    doTaskPoll(api)
  ])
    .then(([ _, response ]) => {
      console.log(`(${pollId}) poll completed with response`, response);

      function setCachedTasksResponse(cachedTasks: Partial<CachedTasks>) {
        return browser.storage.local.set({
          tasksLastCompletedFetchTimestamp: Date.now(),
          ...cachedTasks
        });
      }

      if (isConnectionFailure(response)) {
        if (response.type === 'missing-config') {
          return setCachedTasksResponse({
            taskFetchFailureReason: 'missing-config'
          });
        } else {
          return setCachedTasksResponse({
            taskFetchFailureReason: {
              failureMessage: errorMessageFromConnectionFailure(response)
            }
          });
        }
      } else if (response.success) {
        return setCachedTasksResponse({
          tasks: response.data.tasks,
          taskFetchFailureReason: null
        });
      } else {
        return setCachedTasksResponse({
          taskFetchFailureReason: {
            failureMessage: errorMessageFromCode(response.error.code, 'DownloadStation.Task')
          }
        });
      }
    })
    .catch(error => {
      console.error('unexpected error while trying to poll for new tasks; will not attempt to set anything in browser state', error);
    });
}

const AUTO_DOWNLOAD_TORRENT_FILE_PROTOCOLS = [
  'http',
  'https'
];

const DOWNLOADABLE_PROTOCOLS = [
  'http',
  'https',
  'ftp',
  'ftps',
  'magnet',
  'thunder',
  'flashget',
  'qqdl'
];

interface MetadataFileType {
  mediaType: string;
  extension: string;
}

const METADATA_FILE_TYPES: MetadataFileType[] = [
  { mediaType: 'application/x-bittorrent', extension: '.torrent' },
  { mediaType: 'application/x-nzb', extension: '.nzb' },
];

const ARBITRARY_FILE_FETCH_SIZE_CUTOFF = 1024 * 1024 * 5;

function startsWithAnyProtocol(url: string, protocols: string[]) {
  return protocols.some(protocol => url.startsWith(`${protocol}:`));
}

const FILENAME_PROPERTY_REGEX = /filename=("([^"]+)"|([^"][^ ]+))/;

function guessFileName(urlWithoutQuery: string, headers: Record<string, string>, metadataFileType: MetadataFileType) {
  let maybeFilename: string | undefined;
  const contentDisposition = headers['content-disposition'];
  if (contentDisposition && contentDisposition.indexOf('filename=') !== -1) {
    const regexMatch = FILENAME_PROPERTY_REGEX.exec(contentDisposition);
    maybeFilename = (regexMatch && (regexMatch[2] || regexMatch[3])) || undefined;
  } else {
    maybeFilename = urlWithoutQuery.slice(urlWithoutQuery.lastIndexOf('/') + 1);
  }

  if (maybeFilename == null || maybeFilename.length === 0) {
    maybeFilename = 'download';
  }

  return maybeFilename.endsWith(metadataFileType.extension) ? maybeFilename : maybeFilename + metadataFileType.extension ;
}

const doCreateTask = wrapInNoPermissionsRetry((api: ApiClient, options: DownloadStationTaskCreateRequest) => {
  return api.DownloadStation.Task.Create(options);
});

function partitionPromises<T>(promises: Promise<T>[]): Promise<{ resolved: T[]; rejected: Error[]; }> {
  const accumulator = {
    resolved: [] as T[],
    rejected: [] as Error[]
  };

  const queue = promises.slice();

  function next(): Promise<T | typeof accumulator> {
    if (queue.length === 0) {
      return Promise.resolve(accumulator);
    } else {
      return queue.shift()!
        .then(result => {
          accumulator.resolved.push(result);
        })
        .catch(e => {
          accumulator.rejected.push(e && e instanceof Error
            ? e
            : new Error);
        })
        .then(() => {
          return next();
        })
    }
  }

  return next();
}

export function addDownloadTasksAndPoll(api: ApiClient, urls: string[], path?: string) {
  let notificationId: string | undefined;

  function notifyTaskAddResult(filename?: string) {
    return (result: ConnectionFailure | SynologyResponse<{}>) => {
      console.log('task add result', result);

      if (isConnectionFailure(result)) {
        notify('Failed to connection to DiskStation', 'Please check your settings.', notificationId);
      } else if (result.success) {
        if (urls.length === 1) {
          notify('Download added', filename || urls[0], notificationId);
        } else {
          notify(`${urls.length} downloads added`, undefined, notificationId);
        }
      } else {
        notify('Failed to add download', errorMessageFromCode(result.error.code, 'DownloadStation.Task'), notificationId);
      }
    };
  }

  function notifyUnexpectedError(error: any) {
    console.log('unexpected error while trying to add a download task', error);
    notify('Failed to add download', 'Unexpected error; please check your settings and try again', notificationId);
  }

  function pollOnResponse() {
    return pollTasks(api);
  }

  function maybeMapUrlToFile(url: string): Promise<FormFile | string> {
    if (startsWithAnyProtocol(url, AUTO_DOWNLOAD_TORRENT_FILE_PROTOCOLS)) {
      return Axios.head(url, { timeout: 10000 })
        .then<FormFile | string>(response => {
          const contentType = response.headers['content-type'].toLowerCase();
          const contentLength = response.headers['content-length'];
          const urlWithoutQuery = url.indexOf('?') !== -1 ? url.slice(0, url.indexOf('?')) : url;
          const metadataFileType = find(METADATA_FILE_TYPES, fileType =>
            contentType === fileType.mediaType || urlWithoutQuery.endsWith(fileType.extension)
          );
          if (metadataFileType && !isNaN(+contentLength) && +contentLength < ARBITRARY_FILE_FETCH_SIZE_CUTOFF) {
            return Axios.get(url, { responseType: 'arraybuffer', timeout: 10000 })
              .then(response => {
                const content = new Blob([ response.data ], { type: metadataFileType.mediaType });
                const filename = guessFileName(urlWithoutQuery, response.headers, metadataFileType);
                return { content, filename };
              });
          } else {
            return url;
          }
        });
    } else {
      return Promise.resolve(url);
    }
  }

  function rejectUnknownUrls(taskPromise: Promise<FormFile | string>): Promise<FormFile | string> {
    return taskPromise
      .then(task => {
        if (isFormFile(task)) {
          return task;
        } else {
          if (startsWithAnyProtocol(task, DOWNLOADABLE_PROTOCOLS)) {
            return task;
          } else {
            return Promise.reject(`URL '${task}' must start with one of ${DOWNLOADABLE_PROTOCOLS.join(', ')}`);
          }
        }
      });
  }

  if (urls && urls.length > 0) {
    notificationId = urls.length === 1
      ? notify('Adding download...', urls[0])
      : notify(`Adding ${urls.length} downloads...`);

    const destination = path && path.startsWith('/') ? path.slice(1) : undefined;

    return partitionPromises(urls
      .map(maybeMapUrlToFile)
      .map(rejectUnknownUrls)
    )
      .then(({ resolved, rejected }) => {
        if (resolved.length === 0) {

          return Promise.resolve();
        } else {
          const { file, uri } = resolved.reduce((accumulator, task) => {
            if (isFormFile(task)) {
              accumulator.file.push(task);
            } else {
              accumulator.uri.push(task);
            }
            return accumulator;
          }, { file: [] as FormFile[], uri: [] as string[] });

          // TODO: Test the following:
          // - mixing file and uri
          // - providing one non-empty and one empty
          // - invalid files/uris mixed with valid ones
          // (it seems likely that this response will have to be mixed with previous rejections for aggregation)
          return doCreateTask(api, {
            file,
            uri,
            destination
          })
            // TODO: Notify on completion: how many succeeded and how many didn't?
            .then(pollOnResponse)
        }
      })
      .catch(notifyUnexpectedError);
  } else {
    notify('Failed to add download', 'No URL to download given', notificationId);
    return Promise.resolve();
  }
}
