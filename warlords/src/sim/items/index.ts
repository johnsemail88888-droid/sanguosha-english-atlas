// Imports every item implementation file so their registerItem() calls run.
import './basic';
import './tricks';
import './delayed';

export { getItem, hasItem, registerItem, registeredItemIds } from './registry';
export type { ItemImplEx } from './registry';
