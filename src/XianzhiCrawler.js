const path = require('path');
const { createCrawlerApp } = require('./core/app');

class XianzhiCrawler {
  constructor(options = {}) {
    this.options = options;
    this._aborted = false;
    this.execution = null;
  }

  async run() {
    const app = createCrawlerApp(path.resolve(__dirname, '..'));
    this.execution = app.createRun({
      site: 'xianzhi',
      rawOptions: { ...this.options, site: 'xianzhi' },
      onEvent: this.options.onUpdate,
    });
    if (this._aborted && typeof this.execution.runner.stop === 'function') {
      this.execution.runner.stop();
    }
    await this.execution.runner.run();
  }

  set aborted(value) {
    this._aborted = !!value;
    if (this._aborted && this.execution && typeof this.execution.runner.stop === 'function') {
      this.execution.runner.stop();
    }
  }

  get aborted() {
    return this.execution ? !!this.execution.runner.aborted : this._aborted;
  }
}

module.exports = XianzhiCrawler;
