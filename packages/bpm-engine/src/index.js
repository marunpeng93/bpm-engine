import 'source-map-support/register';

import defaults from 'lib/defaults';
import loadPlugins from 'lib/loadPlugins';
import debug from 'lib/debug';
import TokenInstance from 'lib/TokenInstance';
import Clock from 'lib/Clock';
import makeInterval from 'iso8601-repeating-interval';

import * as constants from 'lib/constants';
import getNextFlowObjects from 'lib/getNextFlowObjects';

const log = debug('engine');

const getTimerEventDefinition = (flowObject) => {
  let timerEventDefinition;

  const { eventDefinitions } = flowObject;
  if (eventDefinitions) {
    eventDefinitions.forEach((eventDefinition) => {
      // if this start event has timereventdefinitions
      if (eventDefinition.$type === constants.BPMN_EVENT_DEFINITION_TIMER) {
        // if it's timer is of type cycle (repetition)
        if (eventDefinition.timeCycle) {
          timerEventDefinition = eventDefinition;
        }
      }
    });
  }
  return timerEventDefinition;
};

/**
 *
 */
class BPMEngine {
  constructor({
    generateId = defaults.generateId,
    evalCondition = defaults.evalCondition,
    persist = new defaults.MemoryPersist(),
    enableClock = true,
    plugins = [],
  } = {}) {
    Object.assign(this, {
      generateId,
      evalCondition,
      persist,
      plugins: loadPlugins(plugins),
    });

    if (enableClock) {
      this.clock = new Clock({ onTick: this.onTick, interval: 100 });
    }

    log('Initiated');
  }

  onTick = async () => {
    log('onTick');
    const currentTimestamp = new Date().getTime();
    const timerEvent = await this.persist.timers.getNext(currentTimestamp);

    if (timerEvent) {
      // set this timer to done, so it won't be returned by above `getNext` again
      await this.persist.timers.update({ timerId: timerEvent.timerId }, { status: 'done' });

      await this.handleTimerEvent(timerEvent);

      // get the next timer after the current one
      const interval = makeInterval(timerEvent.interval);

      // the + 1 is to not get the same timer again
      const nextTimerEvent = interval.firstAfter(timerEvent.time + 1);

      // if there is no next, complete this tick
      if (!nextTimerEvent) {
        return;
      }

      // if the nextTimerEvent's index is lower than the maximum amount of repetitions
      // create a next timer event
      const hasPendingRepetitions = nextTimerEvent.index < interval._repeatCount;
      if (hasPendingRepetitions && timerEvent.intent !== constants.CONTINUE_TOKEN_INSTANCE_INTENT) {
        await this.persist.timers.create({
          timerId: this.generateId(),
          index: nextTimerEvent.index,
          interval: timerEvent.interval,
          time: nextTimerEvent.date / 1,
          previousTimerId: timerEvent.timerId,
          intent: timerEvent.intent,
          workflowDefinitionId: timerEvent.workflowDefinitionId,
        });
      }
    }
  };

  async handleTimerEvent(timerEvent) {
    let token;
    const { intent } = timerEvent;

    // if the intention of the timer is to start a process instance
    // create a new process instance and get its token
    if (intent === constants.START_PROCESS_INSTANCE_INTENT) {
      const { workflowDefinitionId } = timerEvent;
      token = await this.createProcessInstance({ workflowDefinitionId });
    }

    // if the intention of the timer is to continue a token instance
    // get the token instance
    if (intent === constants.CONTINUE_TOKEN_INSTANCE_INTENT) {
      const { tokenId } = timerEvent;
      token = await this.continueTokenInstance({ tokenId });
    }

    // if a token was created/fetched, continue its execution
    if (token) {
      token.execute();
    }
  }

  async createProcessInstance({ workflowDefinition, workflowDefinitionId, payload = {} } = {}) {
    let workflowDefinitionXML;

    if (workflowDefinition) {
      workflowDefinitionXML = workflowDefinition;
    }
    else if (workflowDefinitionId) {
      const deployedWorkflowDefinition = await this.findWorkflowDefinition(workflowDefinitionId);
      if (deployedWorkflowDefinition) {
        workflowDefinitionXML = deployedWorkflowDefinition.xml;
      }
    }

    if (!workflowDefinitionXML) {
      throw new Error('Invalid WorkflowDefinition');
    }

    const processId = this.generateId();
    log(`Creating processInstance ${processId}`);
    await this.persist.processInstances.create({
      processId,
      workflowDefinition: workflowDefinitionXML,
      payload,
    });
    log(`processInstance ${processId} created`);

    const tokenInstance = await this.createTokenInstance({
      processId,
      payload,
      workflowDefinition: workflowDefinitionXML,
    });

    return tokenInstance;
  }

  async createTokenInstance({
    processId,
    payload,
    workflowDefinition,
    tokenId = this.generateId(),
    status,
    parent,
    isSubProcess,
    currentActivity,
    flowObjects,
  }) {
    log(`Creating tokenInstance ${tokenId}`);
    const tokenInstance = new TokenInstance({
      processId,
      tokenId,
      payload,
      workflowDefinition,
      status,
      parent,
      isSubProcess,
      currentActivity,
      engine: this,
    });
    if (!flowObjects) {
      await tokenInstance.initialize();
    }
    else {
      tokenInstance.flowObjects = flowObjects;
    }
    log(`tokenInstance ${tokenId} created`);

    return tokenInstance;
  }

  async continueTokenInstance({ tokenId, payload = {} }) {
    log(`Continuing tokenInstance ${tokenId}`);
    const persistedTokenInstance = await this.findTokenInstance(tokenId);
    const persistedProcessInstance = await this.findProcessInstance(persistedTokenInstance.processId);

    const { workflowDefinition } = persistedProcessInstance;
    const mergedPayload = Object.assign(
      persistedProcessInstance.payload,
      persistedTokenInstance.payload,
      payload,
    );

    const tokenInstance = await this.createTokenInstance({
      processId: persistedProcessInstance.processId,
      payload: mergedPayload,
      workflowDefinition,
      tokenId,
      status: 'paused',
      currentActivity: persistedTokenInstance.next,
      isSubProcess: persistedTokenInstance.isSubProcess,
      parent: persistedTokenInstance.parent,
    });

    tokenInstance.flowObjects = getNextFlowObjects(
      tokenInstance.flowObjects,
      persistedTokenInstance.currentActivity,
    );

    tokenInstance.next = tokenInstance.flowObjects.find(el => el.id === persistedTokenInstance.currentActivity);

    return tokenInstance;
  }

  findTokenInstance(tokenId) {
    return this.persist.tokenInstances.find({ tokenId });
  }

  findProcessInstance(processId) {
    return this.persist.processInstances.find({ processId });
  }

  findWorkflowDefinition(workflowDefinitionId) {
    return this.persist.workflowDefinitions.find({ workflowDefinitionId });
  }

  // create listeners for timer and message start events
  async createStartEvents(dummyTokenInstance, workflowDefinitionId) {
    const { flowObjects } = dummyTokenInstance;

    flowObjects
      .filter(flowObject => flowObject.$type === constants.BPMN_EVENT_START)
      .forEach(async (flowObject) => {
        const timerEventDefinition = getTimerEventDefinition(flowObject);
        if (timerEventDefinition) {
          if (timerEventDefinition.timeCycle) {
            // evaluate the interval
            const intervalExpression = `return \`${timerEventDefinition.timeCycle.body}\`;`;
            const intervalExpressionFunction = new Function('timestamp', intervalExpression);
            const intervalString = intervalExpressionFunction(new Date().toISOString());

            // create the interval and get the first iteration
            const interval = makeInterval(intervalString);
            const firstAfter = interval.firstAfter(new Date() - 1000);

            // if the first iteration is not bigger than the max amount of repetitions
            const hasPendingRepetitions = firstAfter.index <= interval._repeatCount;

            if (hasPendingRepetitions) {
              // create a timer event
              this.persist.timers.create({
                timerId: this.generateId(),
                index: firstAfter.index,
                time: firstAfter.date / 1,
                interval: intervalString,
                intent: constants.START_PROCESS_INSTANCE_INTENT,
                workflowDefinitionId,
              });
            }
          }
        }
      });
  }

  async deployWorkflowDefinition({ xml, workflowDefinitionId = this.generateId() }) {
    const dummyTokenInstance = new TokenInstance({
      workflowDefinition: xml,
    });

    // initialize the tokenInstance so flowObjects get parsed,
    // we use them to get all the StartEvents
    await dummyTokenInstance.initialize();

    const alreadyExistingWorkflowDefinition = await this.persist.workflowDefinitions.find({
      workflowDefinitionId,
    });

    let workflowDefinition;

    if (alreadyExistingWorkflowDefinition) {
      workflowDefinition = await this.persist.workflowDefinitions.update(
        { workflowDefinitionId },
        {
          xml,
        },
      );

      // remove already existing start events for this workflowDefinition
      await this.persist.timers.update(
        { workflowDefinitionId },
        { status: 'done' },
        { multi: true },
      );
    }
    else {
      workflowDefinition = await this.persist.workflowDefinitions.create({
        xml,
        workflowDefinitionId,
      });
    }

    // we need to create the start events after the creation of the workflowDefinition
    // so that a timer can not happen before the workflowDefinition is deployed.
    await this.createStartEvents(dummyTokenInstance, workflowDefinition.workflowDefinitionId);

    return workflowDefinition;
  }
}

export default BPMEngine;
export { default as Plugins } from 'lib/Plugins';
