import type { TableView } from './frickFrackScene';

// Local presentation bridge. Only public/explicitly entitled card views enter here;
// neither this bridge nor the renderer can read the hidden deck or alter gameplay.
let current: TableView | null = null;
export function setFrickFrackView(view: TableView | null): void { current = view; }
export function getFrickFrackView(): TableView | null { return current; }
