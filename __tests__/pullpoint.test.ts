import { findEventTypesInObj } from '../src/onvif/pullPoint';

describe('PullPoint event parsing', () => {
  test('parses @Name/@Value simple item', () => {
    const obj = { '@Name': 'IsMotion', '@Value': 'true' };
    const res = findEventTypesInObj(obj);
    expect(res).toEqual([{ type: 'motion', state: true }]);
  });

  test('parses IsMotion boolean field', () => {
    const obj = { IsMotion: true };
    const res = findEventTypesInObj(obj);
    expect(res).toEqual([{ type: 'motion', state: true }]);
  });

  test('parses line cross string', () => {
    const obj = { message: 'RuleEngine/LineCrossDetector/LineCross' };
    const res = findEventTypesInObj(obj);
    expect(res).toEqual([{ type: 'line', state: undefined }]);
  });

  test('dedupes multiple occurrences', () => {
    const obj = [ { '@Name': 'IsMotion', '@Value': 'true' }, { IsMotion: 'true' } ];
    const res = findEventTypesInObj(obj);
    expect(res).toEqual([{ type: 'motion', state: true }]);
  });
});