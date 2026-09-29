import { EmailRecipientInput } from './email-recipient-input';

/**
 * Instantiated directly rather than through TestBed: the parts worth pinning
 * down here — what commits an address, what splits a pasted list, what
 * Backspace does — are plain logic with no template and no injected anything.
 */
describe('EmailRecipientInput', () => {
  let input: EmailRecipientInput;
  let emitted: string[][];

  beforeEach(() => {
    input = new EmailRecipientInput();
    emitted = [];
    input.recipientsChange.subscribe((value) => emitted.push(value));
  });

  /** A key press the component can read, with preventDefault observable. */
  function press(key: string): { event: KeyboardEvent; prevented: () => boolean } {
    let prevented = false;
    const event = {
      key,
      preventDefault: () => {
        prevented = true;
      },
    } as KeyboardEvent;

    return { event, prevented: () => prevented };
  }

  describe('committing what was typed', () => {
    it('turns the text into a pill on Enter', () => {
      input.text = 'a@b.com';
      input.onKeyDown(press('Enter').event);

      expect(input.recipients).toEqual(['a@b.com']);
      expect(input.text).toBe('');
      expect(emitted).toEqual([['a@b.com']]);
    });

    it('commits on comma and on semicolon too', () => {
      input.text = 'a@b.com';
      input.onKeyDown(press(',').event);

      input.text = 'c@d.com';
      input.onKeyDown(press(';').event);

      expect(input.recipients).toEqual(['a@b.com', 'c@d.com']);
    });

    it('commits on Tab, so leaving the row by keyboard does not lose the address', () => {
      input.text = 'a@b.com';
      const tab = press('Tab');
      input.onKeyDown(tab.event);

      expect(input.recipients).toEqual(['a@b.com']);
      expect(tab.prevented()).toBe(true);
    });

    it('lets a bare Tab move focus on when nothing has been typed', () => {
      const tab = press('Tab');
      input.onKeyDown(tab.event);

      expect(tab.prevented()).toBe(false);
      expect(input.recipients).toEqual([]);
    });

    it('commits on blur, so a typed address is still sent', () => {
      input.text = 'a@b.com';
      input.onBlur();

      expect(input.recipients).toEqual(['a@b.com']);
    });

    it('does nothing on blur when the box is empty or only spaces', () => {
      input.text = '   ';
      input.onBlur();

      expect(input.recipients).toEqual([]);
      expect(emitted).toEqual([]);
    });

    it('takes the address out of a pasted "Name <a@b.com>"', () => {
      input.text = 'Prathhmesh Palkar <p.palkar@example.com>';
      input.onKeyDown(press('Enter').event);

      expect(input.recipients).toEqual(['p.palkar@example.com']);
    });

    it('ignores a duplicate, whatever its case', () => {
      input.recipients = ['a@b.com'];

      input.text = 'A@B.COM';
      input.onKeyDown(press('Enter').event);

      expect(input.recipients).toEqual(['a@b.com']);
      expect(emitted).toEqual([]);
    });
  });

  describe('pasting a list', () => {
    /** A paste event carrying `text`, with preventDefault observable. */
    function paste(text: string): { event: ClipboardEvent; prevented: () => boolean } {
      let prevented = false;
      const event = {
        clipboardData: { getData: () => text },
        preventDefault: () => {
          prevented = true;
        },
      } as unknown as ClipboardEvent;

      return { event, prevented: () => prevented };
    }

    it('splits a semicolon-separated line into separate pills', () => {
      const pasted = paste('a@b.com; c@d.com');
      input.onPaste(pasted.event);

      expect(input.recipients).toEqual(['a@b.com', 'c@d.com']);
      expect(pasted.prevented()).toBe(true);
    });

    it('splits a column pasted out of a spreadsheet', () => {
      input.onPaste(paste('a@b.com\nc@d.com\ne@f.com').event);

      expect(input.recipients).toEqual(['a@b.com', 'c@d.com', 'e@f.com']);
    });

    it('leaves an empty paste alone', () => {
      const pasted = paste('');
      input.onPaste(pasted.event);

      expect(input.recipients).toEqual([]);
      expect(pasted.prevented()).toBe(false);
    });
  });

  describe('removing', () => {
    it('drops the last pill on Backspace when the box is empty', () => {
      input.recipients = ['a@b.com', 'c@d.com'];

      const backspace = press('Backspace');
      input.onKeyDown(backspace.event);

      expect(input.recipients).toEqual(['a@b.com']);
      expect(backspace.prevented()).toBe(true);
    });

    it('leaves the pills alone on Backspace while there is text to delete', () => {
      input.recipients = ['a@b.com'];
      input.text = 'c@';

      const backspace = press('Backspace');
      input.onKeyDown(backspace.event);

      expect(input.recipients).toEqual(['a@b.com']);
      expect(backspace.prevented()).toBe(false);
    });

    it('removes the pill at the index the × belongs to', () => {
      input.recipients = ['a@b.com', 'c@d.com', 'e@f.com'];
      input.removeAt(1);

      expect(input.recipients).toEqual(['a@b.com', 'e@f.com']);
      expect(emitted).toEqual([['a@b.com', 'e@f.com']]);
    });
  });

  describe('validity', () => {
    it('accepts an ordinary address', () => {
      expect(input.isValid('a@b.com')).toBe(true);
      expect(input.isValid('first.last+tag@sub.example.co.in')).toBe(true);
    });

    it('flags one that could not be sent to', () => {
      expect(input.isValid('not-an-address')).toBe(false);
      expect(input.isValid('a@b')).toBe(false);
      expect(input.isValid('a b@c.com')).toBe(false);
    });

    it('still keeps an invalid address as a pill — marked, not dropped', () => {
      input.text = 'not-an-address';
      input.onKeyDown(press('Enter').event);

      expect(input.recipients).toEqual(['not-an-address']);
      expect(input.isValid(input.recipients[0])).toBe(false);
    });
  });
});

/**
 * The "Name <a@b.com>" form, which is what a contact dragged or copied out of
 * Outlook arrives as. Its own block because splitting it wrongly is silent —
 * the display name becomes pills of its own and the address is still there, so
 * the row looks populated while being unsendable.
 */
describe('EmailRecipientInput — pasted contacts', () => {
  let input: EmailRecipientInput;

  beforeEach(() => {
    input = new EmailRecipientInput();
  });

  function paste(text: string): ClipboardEvent {
    return {
      clipboardData: { getData: () => text },
      preventDefault: () => undefined,
    } as unknown as ClipboardEvent;
  }

  it('keeps a display name out of the pills', () => {
    input.onPaste(paste('Prathhmesh Palkar <p.palkar@example.com>'));

    expect(input.recipients).toEqual(['p.palkar@example.com']);
  });

  it('handles several named contacts on one line', () => {
    input.onPaste(paste('Prathhmesh Palkar <p@x.com>; Rita <rita@prideworldcity.com>'));

    expect(input.recipients).toEqual(['p@x.com', 'rita@prideworldcity.com']);
  });

  it('handles named and bare addresses mixed together', () => {
    input.onPaste(paste('Rita <rita@x.com>, plain@y.com'));

    expect(input.recipients).toEqual(['rita@x.com', 'plain@y.com']);
  });

  it('still splits a bare list on spaces', () => {
    input.onPaste(paste('a@b.com c@d.com'));

    expect(input.recipients).toEqual(['a@b.com', 'c@d.com']);
  });
});
