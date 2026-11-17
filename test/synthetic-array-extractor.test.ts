import { expect, it } from 'vitest';
import { startArrayExtraction,extractArrayEvents,finishArrayExtraction } from '../src/synthetic-array-extractor';
import { startSyntheticJsonStream,pushSyntheticJsonFragment,finishSyntheticJsonStream } from '../src/synthetic-stream-json';
it('extracts JSON array records across split UTF-8 and tokenizer pages',()=>{
 const sourceId='a'.repeat(64),scope='b'.repeat(22),input=Array.from({length:101},(_,i)=>({id:i,text:'界'.repeat(600),nested:[true,null,{x:i}]}));
 const bytes=new TextEncoder().encode(JSON.stringify(input));let parser=startSyntheticJsonStream(sourceId,scope),extract=startArrayExtraction(sourceId,scope),records:unknown[]=[];
 const consume=(events:ReturnType<typeof finishSyntheticJsonStream>['events'])=>{while(events.length){const page=extractArrayEvents(extract,sourceId,scope,extract.nextEvent,events);extract=page.state;records.push(...page.records);events=events.slice(page.consumed);}};
 for(let at=0;at<bytes.length;at+=16383){const part=bytes.slice(at,at+16383);let offset=0;while(offset<part.length){const result=pushSyntheticJsonFragment(parser,sourceId,scope,part,offset);parser=result.checkpoint;offset=result.nextOffset;consume(result.events);}}
 const end=finishSyntheticJsonStream(parser,sourceId,scope);consume(end.events);finishArrayExtraction(extract,sourceId,scope);expect(records).toEqual(input);
});
it('rejects wrong roots and incomplete or oversized records',()=>{
 const sourceId='a'.repeat(64),scope='b'.repeat(22),s=startArrayExtraction(sourceId,scope);
 expect(()=>extractArrayEvents(s,sourceId,scope,0,[{type:'object-start'}])).toThrow();
 expect(()=>finishArrayExtraction(s,sourceId,scope)).toThrow();
 expect(()=>extractArrayEvents(s,sourceId,scope,0,[{type:'array-start'},{type:'value',value:'x'.repeat(17000)}])).toThrow();
});
