# Production authoring FAQ

## What is the difference between an Asset, Variety, Production, and a Quantity?

An **Asset** provides media and presentation for something. A **Variety** identifies a kind of trade good and may refer to an Asset. Its optional `production` list describes ways that kind of good could be mined or manufactured. A **Production** entry is a description, not an executable recipe installed by publication.

A **Quantity** is either a **Stack** or an **Item**. A Stack represents a count of a variety with associated data; an Item represents one individually identified object. Production `ingredients` are quantities consumed by a described process, while `yield` entries describe possible quantities of results. `Yield.count` is the count associated with that outcome; the output Variety is the Variety whose Production contains it.

## How do I describe ingredients?

Add one or more ingredient quantities. A Stack has a Variety URI, unsigned integer `count`, and JSON object `data`, for example:

```json
{ "variety": "https://example.test/varieties/ore", "count": 2, "data": {} }
```

An Item has its own Item `id`, the Item's Variety URI, and JSON object `data`; it has no `count` because it represents one identified item:

```json
{ "id": "https://example.test/items/ore-sample-1", "variety": "https://example.test/varieties/ore", "data": { "grade": "A" } }
```

These are distinct from an Asset URI and from `Yield.count`. A Variety URI identifies the kind of ingredient; the Item ID identifies an individual Item.

## How do I describe a location?

`location` is an optional array of **Area objects**, not a string, Port, Vessel, or current-location field. The complete protocol Area shape has `id`, `name`, and `territory`, each identifying the Area, its display name, and its Territory. For example:

```json
{
  "id": "https://example.test/areas/north-mine",
  "name": "North Mine",
  "territory": "https://example.test/territories/island"
}
```

This authoring server validates each supplied location against the full Area shape. The shared Production runtime validator only checks that each array member has a URI `id`; the authority's additional Area validation is why a location with only an ID is not accepted here. The fuller Area metadata does not make location required.

## What do tool, duration, and yield mean?

`tool` is an optional URI reference. `duration` is a required unsigned integer. Each required `yield` array entry has a numeric `probability`, unsigned integer `count`, and JSON object `data`. The current contract requires probabilities to be finite numbers but does not constrain them to a range or require them to sum to a particular value. Do not infer probability normalization rules.

## Are fields optional? Can I add multiple entries?

`ingredients`, `location`, and `tool` may be omitted. If provided, ingredients and locations are arrays and can contain multiple entries. A Variety can have zero or multiple Production entries; omitting `production` and submitting an empty list are both supported. Each Production entry requires `type` (`mine` or `manufacture`), `duration`, and a `yield` array. Each yield entry requires all three of its fields.

The editor's structured mode makes ordinary fields explicit. JSON object fields such as quantity and yield `data` can hold open-ended data. Use advanced Production JSON mode for additional accepted Production fields or payloads that do not fit the structured controls. The selected mode alone is submitted; switching modes preserves each mode's draft, but does not combine or translate them.

## What does validation accept, and what commonly causes HTTP 400?

For Production, the local authoring contract accepts only `mine` or `manufacture`; `duration` and Stack counts must be safe, nonnegative integers. URI fields must be absolute URIs. Quantity `data` and Yield `data` must be JSON objects; Item quantities also need an absolute Item ID. Every yield needs a finite numeric probability, an unsigned integer count, and object data. Supplied `location` entries must each validate as a full Area (`id`, `name`, `territory`). Unknown extension fields on Production objects are retained.

Common 400 causes include malformed JSON; a non-object or unsupported top-level request field; invalid or non-array `production`; a missing/invalid type, duration, or yield array; malformed URI/count/data in an ingredient; a location represented as a string or incomplete Area; invalid yield fields; and invalid Variety name, mass, or version. Variety name and version must be nonempty, and mass must be finite and positive. Linking an Asset that the authenticated Player does not own is a 403, not a 400. Missing or invalid native authentication is a 401.

These are limits of this local authoring validator, not a statement of every possible protocol-profile or Territory rule. For example, probability is checked as a finite number without a normalization rule, and the server does not establish that referenced Areas or Varieties are discoverable or economically usable.

## Does publishing install or execute the Production?

No. Publishing records the signed Variety and its descriptive Production. It does not install a Territory recipe, consume ingredients, or produce cargo. A Territory may apply its own independent rules; local demo production operations are separate from Player-authored descriptions.

## Who can read published creations, and who can edit them?

The authenticated Player's authoring catalog is private to that Player, but published Assets, Varieties, AssetGrants, Player Outbox entries, the public `creations` collection, and Asset text media are public resources. Public text is served as inert text, not interpreted as HTML. Catalog privacy does not make published resources private.

In this local experimental authoring API, a Player can create and link only Assets that the same Player authored and holds. An Asset selection creates an AssetGrant linking that Asset to the new Variety for the Player. The API does not provide an edit/update workflow for these authored objects. Grants describe permission; they do not install Production or authorize a Territory to execute it. Local authoring publication archives signed Create activities but does not enqueue remote delivery.

## Full Production example

This is a complete manufacture entry with two ingredient quantities, one Area, an optional tool, duration, and two possible yield outcomes. The Area includes all metadata required by the authoring server. Probabilities are shown as supplied numeric values; no normalization is implied.

```json
{
  "type": "manufacture",
  "ingredients": [
    {
      "variety": "https://example.test/varieties/ore",
      "count": 2,
      "data": { "grade": "A" }
    },
    {
      "id": "https://example.test/items/catalyst-7",
      "variety": "https://example.test/varieties/catalyst",
      "data": { "reusable": false }
    }
  ],
  "location": [
    {
      "id": "https://example.test/areas/north-foundry",
      "name": "North Foundry",
      "territory": "https://example.test/territories/island"
    }
  ],
  "tool": "https://example.test/assets/press",
  "duration": 4,
  "yield": [
    { "probability": 0.8, "count": 1, "data": { "purity": "standard" } },
    { "probability": 0.2, "count": 2, "data": { "purity": "high" } }
  ]
}
```
