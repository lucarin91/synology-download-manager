import { uniqueId } from 'lodash-es';
import { ApiClient, isConnectionFailure } from 'synology-typescript-api';
import { errorMessageFromCode, errorMessageFromConnectionFailure } from '../apiErrors';
import { CachedTasks } from '../state';
import { wrapInNoPermissionsRetry } from './shared';

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
