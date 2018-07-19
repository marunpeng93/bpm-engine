import Gateway from 'lib/Elements/Gateway';
import serial from 'lib/serial';

export default class InclusiveGateway extends Gateway {
  makeReady = async () => {
    await this.triggerState('ready');
    if (this.tokenInstance.parent) {
      const parentToken = await this.persist.tokenInstance.update(
        {
          tokenId: this.tokenInstance.parent,
        },
        {
          $pull: { childs: this.tokenInstance.tokenId },
        },
      );

      if (parentToken.childs.length > 0) {
        this.tokenInstance.status = 'paused';
      }
    }
  };

  makeComplete = async () => {
    const { outgoing } = this.definition;
    if (outgoing.length > 1) {
      this.tokenInstance.status = 'paused';
      await this.triggerState('complete');

      const { payload } = this.tokenInstance;
      const next = [];

      if (outgoing.length > 1) {
        // eslint-disable-next-line
        for (const path of outgoing) {
          if (path.conditionExpression) {
            const { conditionExpression } = path;
            // eslint-disable-next-line
            (await this.evalCondition(conditionExpression.body, payload)) && next.push(path);
          }
        }
      }
      else {
        next.push(outgoing[0]);
      }

      if (!next.length) {
        if (this.definition.default) {
          next.push(this.definition.default);
        }
        else {
          return;
        }
      }

      const childs = await this.setupChilds(next);
      const childIds = childs.map(child => child.tokenId);

      await this.persistChildIdsToParent(childIds);

      await childs.forEach(async (child) => {
        await this.persist.tokenInstance.create(child.toJSON());
      });

      const funcs = childs.map(child => () => child.exec());

      return serial(funcs);
    }
  };
}
