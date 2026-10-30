import { searchSamples } from '../lib/spliceClient.mjs';

const key = process.argv[2] || 'KSHMR_Stadium_Kick_04_Ouch';

// Bypass our reshaping — call the GraphQL endpoint directly so we see all fields
import { getAuthToken } from '../lib/spliceClient.mjs';

const token = await getAuthToken();
const res = await fetch('https://surfaces-graphql.splice.com/graphql', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({
    operationName: 'SamplesSearch',
    variables: {
      order: 'DESC', sort: 'popularity', limit: 3, page: 1,
      tags: [], key: null, chord_type: null, bpm: null, min_bpm: null, max_bpm: null,
      asset_category_slug: null, random_seed: null, attributes: [],
      filepath: key, query: key, licensed: true, liked: null, ac_uuid: null,
    },
    query: `query SamplesSearch($limit:Int=50,$page:Int=1,$filepath:String,$query:String,$licensed:Boolean,$tags:[ID],$key:String,$chord_type:String,$bpm:String,$min_bpm:Int,$max_bpm:Int,$asset_category_slug:AssetCategorySlug,$random_seed:String,$attributes:[AssetAttributeSlug!],$ac_uuid:String,$liked:Boolean,$sort:AssetSortType=popularity,$order:SortOrder=DESC){
      assetsSearch(filter:{attributes:$attributes,legacy:true,published:true,asset_type_slug:sample,query:$query,filepath:$filepath,tag_ids:$tags,key:$key,chord_type:$chord_type,bpm:$bpm,min_bpm:$min_bpm,max_bpm:$max_bpm,asset_category_slug:$asset_category_slug,ac_uuid:$ac_uuid,licensed:$licensed,liked:$liked},pagination:{page:$page,limit:$limit},sort:{sort:$sort,order:$order,random_seed:$random_seed}){
        items{
          ... on IAsset { uuid __typename }
          ... on SampleAsset { catalog_uuid name files { uuid name path asset_file_type_slug __typename } __typename }
          __typename
        }
        __typename
      }
    }`,
  }),
});
const json = await res.json();
console.log(JSON.stringify(json, null, 2));
