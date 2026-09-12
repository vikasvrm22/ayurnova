/**
 * Phase 6B - returned-stock intake. Deliberately NOT restock_order()
 * (Phase 5B): cancellation restocks because nothing ever left the
 * warehouse, so the original batch's sellability is still trustworthy. A
 * return is physically different - goods are coming BACK, condition
 * unknown, and must clear QC before they can ever be sold again.
 *
 * receiveReturnedItem() creates a brand-new batch per returned line, with
 * quality_status='pending' from the moment it's created. Reuses Phase 5A's
 * adjust_batch_quantity()/is_batch_sellable() completely unchanged - since
 * a 'pending' batch is never sellable, adding its quantity via
 * adjust_batch_quantity() correctly writes a ledger entry (full audit
 * trail) WITHOUT touching product_variants.stock at all. The batch only
 * ever starts contributing to sellable stock once staff flips it to
 * quality_status='passed' via the EXISTING Phase 5C admin inventory UI
 * (PUT /api/admin/inventory/batches/:id/status -> set_batch_status()) -
 * that page IS the QC review step; nothing new needed for it.
 */
import { supabaseAdmin } from "../db/supabaseClient.js";

/** One QC-pending batch per return_request_item, batch_number keyed off
 * that row's own id so it can never collide with another batch for the
 * same variant (unique(variant_id, batch_number)). Links the batch back
 * onto the return_request_item row for traceability. */
export async function receiveReturnedItem({ variantId, qty, returnRequestItemId, actor }) {
  const { data: batch, error: insertError } = await supabaseAdmin()
    .from("batches")
    .insert({
      variant_id: variantId,
      batch_number: `RETURN-${returnRequestItemId}`,
      quality_status: "pending",
      batch_status: "active",
      created_by: actor,
    })
    .select()
    .single();
  if (insertError) throw insertError;

  const { error: adjustError } = await supabaseAdmin().rpc("adjust_batch_quantity", {
    p_batch_id: batch.id, p_delta: qty, p_reason: "return_received", p_actor: actor,
  });
  if (adjustError) throw adjustError;

  await supabaseAdmin().from("return_request_items").update({ batch_id: batch.id }).eq("id", returnRequestItemId);

  return batch;
}
