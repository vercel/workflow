import { CHAIN_CLASS_ID } from '../chain-ref.js';
import { aliasSerializationClass } from '../class-serialization.js';
import { Chain } from './chain.js';

// Every workflow bundle imports this module. Registering the same constructor
// that the public workflow entry exports lets built-in Chain refs cross a
// workflow even when application code only passes them through transitively.
aliasSerializationClass(CHAIN_CLASS_ID, Chain);
