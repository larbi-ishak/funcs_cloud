import NodeCache from 'node-cache';
import logger from '../utils/logger.js';

// We use checkperiod = 5s
const cache = new NodeCache({ checkperiod: 5, useClones: false });

cache.on('del', (key) => {
    logger.debug(`Cache expired/deleted: ${key}`);
});

export default cache;
