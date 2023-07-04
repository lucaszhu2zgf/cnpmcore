import { app, mock } from 'egg-mock/bootstrap';
import { Change } from '../../../app/core/entity/Change';
import assert from 'assert';
import { PACKAGE_VERSION_ADDED } from '../../../app/core/event';
import { ChangeRepository } from '../../../app/repository/ChangeRepository';
import { HookManageService } from '../../../app/core/service/HookManageService';
import { HookType } from '../../../app/common/enum/Hook';
import { HookEvent } from '../../../app/core/entity/HookEvent';
import { Task } from '../../../app/core/entity/Task';
import { CreateHookTriggerService } from '../../../app/core/service/CreateHookTriggerService';
import { TestUtil } from '../../TestUtil';
import { UserRepository } from '../../../app/repository/UserRepository';
import { TaskState, TaskType } from '../../../app/common/enum/Task';
import { MQAdapter } from '../../../app/infra/MQAdapter';
import { Queue } from 'bullmq';

describe('test/core/worker/HookTriggerWorker.test.ts', () => {

  before(async () => {
    mock(app.config.cnpmcore, 'hookEnable', true);
  });

  describe('trigger hook', () => {

    let change: Change;
    let hookManageService: HookManageService;
    let taskId: string;
    let queue: Queue;
    const pkgName = '@cnpmcore/foo';

    beforeEach(async () => {
      app.mockLog();
      const { name: username } = await TestUtil.createUser();
      await TestUtil.createPackage({ name: pkgName });
      change = Change.create({
        type: PACKAGE_VERSION_ADDED,
        targetName: pkgName,
        data: {
          version: '1.0.0',
        },
      });
      app.mockHttpclient('http://foo.com', 'POST', {
        status: 200,
      });
      const changeRepository = await app.getEggObject(ChangeRepository);
      await changeRepository.addChange(change);
      const userRepository = await app.getEggObject(UserRepository);
      const user = await userRepository.findUserByName(username);
      const userId = user!.userId;
      hookManageService = await app.getEggObject(HookManageService);
      await hookManageService.createHook({
        type: HookType.Package,
        ownerId: userId,
        name: pkgName,
        endpoint: 'http://foo.com',
        secret: 'mock_secret',
      });

      const mqAdapter = await app.getEggObject(MQAdapter);
      queue = mqAdapter.initQueue(TaskType.TriggerHook);
      await queue.obliterate();

    });

    it('should work', async () => {

      await app.ready();
      const task = Task.createCreateHookTask(HookEvent.createPublishEvent(pkgName, change.changeId, '1.0.0', 'latest'));
      taskId = task.taskId;
      const createHookTriggerService = await app.getEggObject(CreateHookTriggerService);
      await createHookTriggerService.executeTask(task);
      assert.equal(task?.state, TaskState.Success);
      assert(taskId);

      await TestUtil.waitUntilQueueClean(queue);
      app.expectLog('trigger_hook_worker:subscribe:executeTask:start');
      app.expectLog('trigger_hook_worker:subscribe:executeTask:success');

    });

    it('should ignore invalid task', async () => {

      await app.ready();
      const mqAdapter = await app.getEggObject(MQAdapter);
      await mqAdapter.addJobs(TaskType.TriggerHook, {
        taskId: 'a123',
        targetName: 'banana',
      });

      await TestUtil.waitUntilQueueClean(queue);
      assert.equal(await queue.count(), 0);

    });
  });

});
