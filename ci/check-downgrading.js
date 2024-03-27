const { join, posix, sep } = require('path');
const { readFileSync, existsSync } = require('fs');
const { mkdir, rm } = require('shelljs');
const { platform } = require('os');
const { run, resolveTaskList, logToPipeline } = require('./ci-util');
const { eq, inc, parse, lte, neq, gt, compare, SemVer, patch } = require('semver');

const taskVersionBumpingDocUrl = 'https://aka.ms/azp-tasks-version-bumping';

const packageEndpoint = process.env['PACKAGE_VERSIONS_ENDPOINT'];

// An example:
// PACKAGE_TOKEN={token} PACKAGE_VERSIONS_ENDPOINT={package_versions_endpoint} SYSTEM_PULLREQUEST_SOURCEBRANCH=refs/head/{local_branch_name} SYSTEM_PULLREQUEST_TARGETBRANCH={target_branch_eg_master} node ./ci/check-downgrading.js --task "@({tasks_names})" --sprint {current_sprint_number}

// if (!packageEndpoint) {
//   logToPipeline(
//     'error',
//     'Failed to get info from package endpoint because no endpoint was specified. Try setting the PACKAGE_VERSIONS_ENDPOINT environment variable.'
//   );
//   process.exit(1);
// }

const { RestClient } = require('typed-rest-client/RestClient');
const { config } = require('process');
const client = new RestClient('azure-pipelines-tasks-ci', '');

const argv = require('minimist')(process.argv.slice(2));

if (!argv.task) {
  console.log(`$(task_pattern) variable is empty or not set. Aborting...`);
  process.exit(0);
}

// We need to escape # on Unix platforms since that turns the rest of the string into a comment
const escapeHash = str => (platform() == 'win32' ? str : str.replace(/#/gi, '\\#'));

const sourceBranch = escapeHash(process.env['SYSTEM_PULLREQUEST_SOURCEBRANCH']);
const targetBranch = escapeHash(process.env['SYSTEM_PULLREQUEST_TARGETBRANCH']);

console.log(sourceBranch);
console.log(targetBranch);

const baseProjectPath = join(__dirname, '..');
const tempMasterTasksPath = join(baseProjectPath, 'temp', 'tasks-versions', targetBranch);

const simpleVersionMapRegex = /(?<configName>.*)\|(?<version>.*)$/;

if (!existsSync(tempMasterTasksPath)) {
  mkdir('-p', tempMasterTasksPath);
}

if (existsSync(join(tempMasterTasksPath, 'Tasks'))) {
  rm('-rf', join(tempMasterTasksPath, 'Tasks'));
}

function prCheck() {
  const modifiedVersionMapFiles = getModifiedVersionMapFiles(targetBranch, sourceBranch);
  if (modifiedVersionMapFiles.length == 0) return;

  const messages = [];

  const targetBranchMappings = {};
  const sourceBranchMappings = {};
  modifiedVersionMapFiles.forEach(filePath => {
    //get task name from a string like _generated/TaskNameVN.versionmap.txt
    const taskName = filePath.slice(11, -15); //get task name from
    targetBranchMappings[taskName] = parseVersionMap(getVersionMapContent(filePath, targetBranch));
    sourceBranchMappings[taskName] = parseVersionMap(getVersionMapContent(filePath, sourceBranch));
  });

  for (const task in targetBranchMappings) {
    console.log('checking task:' + task);
    compareConfigs(targetBranchMappings[task], sourceBranchMappings[task]);
  }
}

function compareConfigs(targetConfig, sourceConfig) {
  for (const config in targetConfig) {
    console.log('checking config:' + config);
    // Check that new version is greater thatn old version + 1
    if (!gt(sourceConfig[config], inc(targetConfig[config], 'patch'))) {
      console.log(` ${config} : ${sourceConfig[config]} should be bumped`);
    }
  }
}

function getModifiedVersionMapFiles(targetBranch, sourceBranch) {
  const versionmapPathRegex = /_generated\/.*versionmap.txt$/;
  const versionMapFiles = run(`git --no-pager diff --name-only --diff-filter=M origin/${targetBranch}..origin/${sourceBranch}`)
    .split('\n')
    .filter(line => line.match(versionmapPathRegex));
  return versionMapFiles;
}

function getVersionMapContent(versionMapFilePath, branchName) {
  return run(`git show origin/${branchName}:${versionMapFilePath}`);
}

function parseVersionMap(fileContent) {
  const versionMap = {};
  fileContent.split('\n').forEach(line => {
    simpleVersionMapRegex.test(line);
    var match = simpleVersionMapRegex.exec(line);
    versionMap[match[1]] = match[2];
  });

  return versionMap;
}

function checkMasterVersions(masterTasks, sprint, isReleaseTagExist, isCourtesyWeek) {
  const messages = [];

  for (const masterTask of masterTasks) {
    if (masterTask.version.minor <= sprint) {
      continue;
    }

    if (isReleaseTagExist || isCourtesyWeek) {
      continue;
    }

    messages.push({
      type: 'warning',
      payload: `[${targetBranch}] ${masterTask.name} has v${masterTask.version.version} it's higher than the current sprint ${sprint}`
    });
  }

  return messages;
}

function compareLocalToMaster(localTasks, masterTasks, sprint) {
  const messages = [];

  for (const localTask of localTasks) {
    const masterTask = masterTasks.find(x => x.name.toLowerCase() === localTask.name.toLowerCase());

    if (masterTask === undefined) {
      continue;
    }

    if (localTask.version.minor < sprint) {
      const destinationVersion = parse(masterTask.version.version);
      destinationVersion.minor = sprint;

      messages.push({
        type: 'error',
        payload: `${localTask.name} have to be upgraded (task.json, task.loc.json) from v${
          localTask.version.version
        } to v${destinationVersion.format()} at least since local minor version is less than the sprint version(${taskVersionBumpingDocUrl})`
      });
      continue;
    }

    if (localTask.version.minor === sprint && eq(localTask.version, masterTask.version)) {
      messages.push({
        type: 'error',
        payload: `${localTask.name} have to be upgraded (task.json, task.loc.json) from v${localTask.version.version} to v${inc(
          masterTask.version,
          'patch'
        )} at least since local version is equal to the master version (${taskVersionBumpingDocUrl})`
      });
      continue;
    }
  }

  return messages;
}

function checkLocalVersions(localTasks, sprint, isReleaseTagExist, isCourtesyWeek) {
  const messages = [];

  for (const localTask of localTasks) {
    if (localTask.version.minor < sprint) {
      messages.push({
        type: 'error',
        payload: `${localTask.name} have to be upgraded (task.json, task.loc.json) from v${localTask.version.minor} to v${sprint} at least since local minor version is less than the sprint version(${taskVersionBumpingDocUrl})`
      });
      continue;
    }

    if (localTask.version.minor === sprint && isCourtesyWeek) {
      messages.push({
        type: 'warning',
        payload: `Be careful with task ${localTask.name} version and check it attentively as the current week is courtesy push week`
      });
      continue;
    }

    if (localTask.version.minor > sprint && !isReleaseTagExist && !isCourtesyWeek) {
      messages.push({
        type: 'error',
        payload: `[${sourceBranch}] ${localTask.name} has v${localTask.version.version} it's higher than the current sprint ${sprint} (${taskVersionBumpingDocUrl})`
      });
      continue;
    }
  }

  return messages;
}

function readVersionsFromTaskJsons(tasks, basepath) {
  return tasks.map(x => {
    const taskJSONPath = join(basepath, 'Tasks', x, 'task.json');

    if (!existsSync(taskJSONPath)) {
      logToPipeline('error', `Task.json of ${x} does not exist by path ${taskJSONPath}`);
      process.exit(1);
    }

    const taskJSONObject = JSON.parse(readFileSync(taskJSONPath, 'utf-8'));

    return {
      id: taskJSONObject.id,
      name: x,
      version: parse([taskJSONObject.version.Major, taskJSONObject.version.Minor, taskJSONObject.version.Patch].join('.'))
    };
  });
}

async function clientWrapper(url) {
  try {
    return await client.get(url);
  } catch (error) {
    logToPipeline('error', `Cannot access to ${url} due to error ${error}`);
    process.exit(1);
  }
}

async function getTaskVersionsFromFeed() {
  const { result, statusCode } = await clientWrapper(packageEndpoint);

  if (statusCode !== 200) {
    logToPipeline('error', `Failed while fetching feed versions.\nStatus code: ${statusCode}\nResult: ${result}`);
    process.exit(1);
  }

  return result.value.map(x => ({
    name: x.name.slice('Mseng.MS.TF.DistributedTask.Tasks.'.length),
    versions: x.versions.map(y => ({
      version: parse(y.version),
      isLatest: y.isLatest
    }))
  }));
}

function compareLocalToFeed(localTasks, feedTasks, sprint) {
  const messages = [];

  for (const localTask of localTasks) {
    const feedTask = feedTasks.find(x => x.name.toLowerCase() === localTask.name.toLowerCase());

    if (feedTask === undefined) {
      continue;
    }

    for (const feedTaskVersion of feedTask.versions) {
      if (feedTaskVersion.version.minor > sprint) {
        messages.push({
          type: 'warning',
          payload: `[Feed] ${feedTask.name} has v${feedTaskVersion.version.version} it's higher than the current sprint ${sprint}`
        });
        continue;
      }

      if (lte(localTask.version, feedTaskVersion.version) && feedTaskVersion.isLatest) {
        messages.push({
          type: 'warning',
          payload: `[Feed] ${localTask.name} local version ${localTask.version.version} less or equal than version in feed ${feedTaskVersion.version.version}`
        });
      }
    }
  }

  return messages;
}

function compareLocalTaskLoc(localTasks) {
  const messages = [];

  for (const localTask of localTasks) {
    const taskLocJSONPath = join(__dirname, '..', 'Tasks', localTask.name, 'task.loc.json');

    if (!existsSync(taskLocJSONPath)) {
      logToPipeline('error', `Task.json of ${localTask.name} does not exist by path ${taskLocJSONPath}`);
      process.exit(1);
    }

    const taskLocJSONObject = JSON.parse(readFileSync(taskLocJSONPath, 'utf-8'));
    const taskLocJSONVersion = [taskLocJSONObject.version.Major, taskLocJSONObject.version.Minor, taskLocJSONObject.version.Patch].join('.');

    if (neq(localTask.version, parse(taskLocJSONVersion))) {
      messages.push({
        type: 'error',
        payload: `[Loc] ${localTask.name} task.json v${localTask.version.version} does not match with task.loc.json v${taskLocJSONVersion} (${taskVersionBumpingDocUrl})`
      });
    }
  }

  return messages;
}

function loadTaskJsonsFromMaster(names) {
  names.forEach(x => {
    mkdir('-p', join(tempMasterTasksPath, 'Tasks', x));
    run(`git show origin/master:Tasks/${x}/task.json > ${tempMasterTasksPath.split(sep).join(posix.sep)}/Tasks/${x}/task.json`);
  });
}

function doesTaskExistInMasterBranch(name) {
  try {
    // If task.json doesn't exist in the main branch it means that it's a new task
    run(`git cat-file -e origin/master:Tasks/${name}/task.json`, true);
  } catch (error) {
    return false;
  }

  return true;
}

async function main({ task, sprint, week }) {
  const taskList = resolveTaskList(task);

  const localTasks = readVersionsFromTaskJsons(taskList, join(__dirname, '..'));
  const masterTaskList = taskList.filter(x => doesTaskExistInMasterBranch(x));
  loadTaskJsonsFromMaster(masterTaskList);
  const masterTasks = readVersionsFromTaskJsons(masterTaskList, tempMasterTasksPath);
  //const feedTaskVersions = await getTaskVersionsFromFeed();
  const isReleaseTagExist = run(`git tag -l v${sprint}`).length !== 0;
  const isCourtesyWeek = week === 3;

  prCheck();

  const messages = [
    // ...checkMasterVersions(masterTasks, sprint, isReleaseTagExist, isCourtesyWeek),
    // ...compareLocalToMaster(localTasks, masterTasks, sprint),
    // ...checkLocalVersions(localTasks, sprint, isReleaseTagExist, isCourtesyWeek),
    //...compareLocalToFeed(localTasks, feedTaskVersions, sprint),
    //...compareLocalTaskLoc(localTasks)
  ];

  if (messages.length > 0) {
    console.warn(`\nProblems with ${messages.length} task(s) should be resolved:\n`);

    for (const message of messages) {
      logToPipeline(message.type, message.payload);
    }

    console.log('\nor you might have an outdated branch, try to merge/rebase your branch from master');

    // If only we have errors, we should fail the build
    if (messages.some(x => x.type === 'error')) {
      process.exit(1);
    }
  }
}

main(argv).catch(error => {
  console.error(error);
  process.exit(1);
});
