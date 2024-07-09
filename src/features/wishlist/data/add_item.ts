import { notion } from "../../../notion";
import { cache } from "../../common/cache";
import { ONE_DAY, timeSince } from "../../common/time_utils";
import { getVoterById } from "./get_voter";
import {
  WishlistItem,
  queryWishlistItems,
  wishlistDatabaseId,
} from "./query_items";

/**
 * Interface for a new wishlist item.
 */
interface NewWishlistItem {
  title: string;
  description: string;
  createdBy: string;
  createdByUser: string;
}

/**
 * Creates a new entry in the wishlist database.
 *
 * @param item The data for the new entry.
 */
export async function addWishlistItem(item: NewWishlistItem) {
  var resp = await notion.pages.create({
    parent: {
      type: "database_id",
      database_id: wishlistDatabaseId,
    },
    properties: {
      Title: {
        type: "title",
        title: [{ type: "text", text: { content: item.title } }],
      },
      Description: {
        type: "rich_text",
        rich_text: [{ type: "text", text: { content: item.description } }],
      },
      // Set the creating user as the first voter on this entry.
      Voted: {
        type: "relation",
        relation: [{ id: item.createdBy }],
      },
    },
  });

  const items = await cache.get<WishlistItem[]>("wishlist");
  await cache.set("wishlist", [
    ...(items ?? []),
    {
      id: resp.id,
      title: item.title,
      description: item.description,
      voters: [await getVoterById(item.createdByUser)],
      timeSinceCreated: timeSince(new Date().toISOString()),
    },
  ]);
}
