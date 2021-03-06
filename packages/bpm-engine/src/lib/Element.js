import debug from 'lib/debug';
import serial from 'lib/serial';

const log = debug('process:plugins');

export default class Element {
  constructor({ definition, plugins, tokenInstance }) {
    this.definition = definition;
    this.plugins = plugins;
    this.tokenInstance = tokenInstance;
    this.engine = tokenInstance.engine;
    this.evalCondition = this.engine.evalCondition;
    this.persist = this.engine.persist;
  }

  callPlugins = (fn, extra) => {
    log(`${this.tokenInstance.tokenId} > ${this.definition.id} > ${fn}`);

    const promises = [];
    Object.keys(this.plugins).forEach((pluginName) => {
      if (this.plugins[pluginName][fn]) {
        const plugin = this.plugins[pluginName][fn];
        promises.push(plugin(this.definition, this.tokenInstance, extra));
      }
    });
    return Promise.all(promises);
  };

  makeReady = () => this.callPlugins('onReady');
  makeActive = () => this.callPlugins('onActive');
  makeComplete = () => this.callPlugins('onComplete');

  persistChildIdsToParent = childIds =>
    this.persist.tokenInstances.update(
      { tokenId: this.tokenInstance.tokenId },
      {
        $set: {
          currentActivity: this.definition.id,
          childs: childIds,
          status: this.tokenInstance.status,
        },
      },
    );

  processChilds = async (childTokenInstances) => {
    const childTokenInstancesIds = childTokenInstances.map(child => child.tokenId);
    await this.persistChildIdsToParent(childTokenInstancesIds);
    await Promise.all(childTokenInstances.map(childTokenInstance => childTokenInstance.persistCreate()));
    await serial(childTokenInstances.map(childTokenInstance => childTokenInstance.execute));
  };

  instantiateChildTokenInstances = outgoing =>
    Promise.all(outgoing.map(async (path) => {
      const token = await this.engine.createTokenInstance({
        payload: this.tokenInstance.payload,
        processId: this.tokenInstance.processId,
        parent: this.tokenInstance.tokenId,
        isSubProcess: this.tokenInstance.isSubProcess,
        currentActivity: path.id,
        status: 'running',
        flowObjects: this.tokenInstance.flowObjects,
      });

      token.next = token.flowObjects.find(el => el.id === path.id);

      return token;
    }));
}
