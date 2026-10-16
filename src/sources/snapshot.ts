import type { Entry, Source } from "../entries.ts";

const WAYBACK_STAMP = /\/web\/(\d{4})(\d{2})(\d{2})\d*id_\//;

/**
 * A dated Wayback Machine copy of a page: how documentation read at one moment, for tracking
 * how guidance changed. One entry, published on the snapshot's day; the text is fetched on
 * expansion, so a seen snapshot costs nothing on later runs.
 */
export const fetchSnapshotEntries = (source: Source): Promise<Entry[]> => {
  const stamp = WAYBACK_STAMP.exec(source.location);
  if (stamp === null) throw new Error(`${source.id}: not a Wayback "id_" snapshot URL`);
  return Promise.resolve([
    {
      id: `${source.id}:${source.location}`,
      source,
      title: source.title,
      url: source.location,
      publishedOn: `${stamp[1]}-${stamp[2]}-${stamp[3]}`,
      text: "",
    },
  ]);
};
