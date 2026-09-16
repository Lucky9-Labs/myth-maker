// Unchanged lookup helper extracted from the accepted mechanical-legs module.
export function findRigNode(root, name) {
  let found;
  root.traverse(n => { if (n.name === name || n.userData.name === name || n.name === name.replaceAll('.', '')) found = n; });
  if (!found) throw new Error(`Missing rig node ${name}`);
  return found;
}
